const prisma = require('../config/prisma');

/**
 * التحقق من إيصالات Apple In-App Purchase.
 *
 * المبدأ: التطبيق لا يمنح صلاحية لنفسه. يرسل الإيصال، والخادم يسأل آبل،
 * ويكتب النتيجة في جدول Subscription، وهو المصدر الوحيد للحقيقة.
 *
 * متغيرات البيئة:
 *   APPLE_SHARED_SECRET  → App Store Connect ← App-Specific Shared Secret
 *   APPLE_BUNDLE_ID      → com.uabber.learn
 */

const PROD_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';

const BUNDLE_ID = process.env.APPLE_BUNDLE_ID || 'com.uabber.learn';

const ACTIVE = 'active';
const EXPIRED = 'expired';

/**
 * الباقات المسموح بها ومقابلها في حقول planName / planMonths
 * حتى تظهر في لوحة الأدمن والسجل بنفس شكل الباقات اليدوية.
 */
const APPLE_PLANS = {
  'com.uabber.learn.monthly': {
    planName: 'اشتراك شهر (App Store)',
    planMonths: 1,
  },
  'com.uabber.learn.sixmonths': {
    planName: 'اشتراك 6 أشهر (App Store)',
    planMonths: 6,
  },
  'com.uabber.learn.yearly': {
    planName: 'اشتراك سنة (App Store)',
    planMonths: 12,
  },
};

/** لا نعيد سؤال آبل أكثر من مرة كل ١٥ دقيقة لنفس الاشتراك. */
const RECHECK_INTERVAL_MS = 15 * 60 * 1000;

function isKnownProduct(productId) {
  return Object.prototype.hasOwnProperty.call(APPLE_PLANS, productId);
}

async function callApple(receipt, url) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      'receipt-data': receipt,
      password: process.env.APPLE_SHARED_SECRET,
      'exclude-old-transactions': true,
    }),
  });

  if (!response.ok) {
    const error = new Error(`Apple HTTP ${response.status}`);
    error.statusCode = 502;
    throw error;
  }

  return response.json();
}

/**
 * يعيد أحدث اشتراك في الإيصال، أو null إن لم يوجد اشتراك معروف.
 */
async function verifyAppleReceipt(receipt) {
  if (!process.env.APPLE_SHARED_SECRET) {
    const error = new Error('APPLE_SHARED_SECRET is not configured');
    error.statusCode = 500;
    throw error;
  }

  // نبدأ بالإنتاج دائمًا ثم ننتقل إلى sandbox عند 21007 (توصية آبل).
  let data = await callApple(receipt, PROD_URL);
  let environment = 'Production';

  if (data.status === 21007) {
    data = await callApple(receipt, SANDBOX_URL);
    environment = 'Sandbox';
  }

  if (data.status !== 0) {
    const error = new Error(`Apple receipt status ${data.status}`);
    error.appleStatus = data.status;
    error.statusCode = 400;
    throw error;
  }

  const bundleId = data.receipt && data.receipt.bundle_id;

  if (bundleId !== BUNDLE_ID) {
    const error = new Error(`Bundle mismatch: ${bundleId}`);
    error.statusCode = 400;
    throw error;
  }

  const items = Array.isArray(data.latest_receipt_info)
    ? data.latest_receipt_info
    : [];

  let best = null;

  for (const item of items) {
    if (!isKnownProduct(item.product_id)) continue;

    const expiresMs = Number(item.expires_date_ms || 0);
    if (!expiresMs) continue;

    if (!best || expiresMs > best.expiresAt.getTime()) {
      best = {
        expiresAt: new Date(expiresMs),
        productId: item.product_id,
        originalTransactionId: String(item.original_transaction_id),
        isCancelled: Boolean(item.cancellation_date_ms),
      };
    }
  }

  if (!best) return null;

  return {
    ...best,
    environment,
    latestReceipt: data.latest_receipt || receipt,
  };
}

/**
 * كتابة نتيجة التحقق في جدول Subscription.
 * يرمي خطأ 409 إذا كان الاشتراك مربوطًا بحساب آخر.
 */
async function upsertAppleSubscription(userId, verified, tx = prisma) {
  const plan = APPLE_PLANS[verified.productId] || {
    planName: verified.productId,
    planMonths: null,
  };

  const isActive =
    !verified.isCancelled && verified.expiresAt.getTime() > Date.now();

  const existing = await tx.subscription.findUnique({
    where: { appleOriginalTransactionId: verified.originalTransactionId },
  });

  if (existing && existing.userId !== userId) {
    const error = new Error(
      'هذا الاشتراك مرتبط بحساب آخر. سجّل الدخول بذلك الحساب.'
    );
    error.statusCode = 409;
    throw error;
  }

  const data = {
    status: isActive ? ACTIVE : EXPIRED,
    planName: plan.planName,
    planMonths: plan.planMonths,
    amount: null,
    expiryDate: verified.expiresAt,
    provider: 'apple',
    appleProductId: verified.productId,
    appleLatestReceipt: verified.latestReceipt,
    appleEnvironment: verified.environment,
    appleLastCheckedAt: new Date(),
  };

  if (existing) {
    return tx.subscription.update({
      where: { id: existing.id },
      data,
    });
  }

  return tx.subscription.create({
    data: {
      ...data,
      userId,
      startDate: new Date(),
      appleOriginalTransactionId: verified.originalTransactionId,
    },
  });
}

/**
 * إعادة سؤال آبل عن اشتراكات المستخدم المنتهية محليًا.
 *
 * هذا بديل عن App Store Server Notifications: عندما يمر تاريخ الانتهاء
 * المخزَّن، نسأل آبل مرة أخرى بالإيصال المحفوظ فنلتقط التجديد التلقائي
 * دون الحاجة إلى webhook أو مهمة مجدولة (مهم على Render المجاني).
 *
 * لا يرمي أخطاء أبدًا — فشل الاتصال بآبل يجب ألا يُسقط /me.
 */
async function refreshAppleSubscriptions(userId, tx = prisma) {
  if (!userId || !process.env.APPLE_SHARED_SECRET) return;

  const now = new Date();
  const recheckBefore = new Date(now.getTime() - RECHECK_INTERVAL_MS);

  const candidates = await tx.subscription.findMany({
    where: {
      userId,
      provider: 'apple',
      appleLatestReceipt: { not: null },
      expiryDate: { lte: now },
      OR: [
        { appleLastCheckedAt: null },
        { appleLastCheckedAt: { lte: recheckBefore } },
      ],
    },
  });

  for (const subscription of candidates) {
    try {
      const verified = await verifyAppleReceipt(
        subscription.appleLatestReceipt
      );

      if (!verified) {
        await tx.subscription.update({
          where: { id: subscription.id },
          data: { appleLastCheckedAt: new Date() },
        });
        continue;
      }

      await upsertAppleSubscription(userId, verified, tx);
    } catch (error) {
      console.error(
        `[apple-iap] refresh failed for subscription ${subscription.id}:`,
        error.message
      );

      // نحدّث وقت الفحص فقط حتى لا نعيد المحاولة في كل طلب.
      await tx.subscription
        .update({
          where: { id: subscription.id },
          data: { appleLastCheckedAt: new Date() },
        })
        .catch(() => {});
    }
  }
}

module.exports = {
  APPLE_PLANS,
  isKnownProduct,
  verifyAppleReceipt,
  upsertAppleSubscription,
  refreshAppleSubscriptions,
};
