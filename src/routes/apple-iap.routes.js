const express = require('express');
const rateLimit = require('express-rate-limit');
const prisma = require('../config/prisma');
const { auth } = require('../middleware/auth');
const { addPlanDuration } = require('./subscriptions.routes');
const { ownProfile } = require('./specialists.routes');
const {
  isKnownProduct,
  planForProduct,
  verifyAppleReceipt,
  verifySpecialistPurchase,
  upsertAppleSubscription,
} = require('../services/appleIap');

const router = express.Router();

/**
 * حدّ خاص بالتحقق: كل استدعاء يعني طلبًا صادرًا إلى خوادم آبل.
 */
const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'محاولات كثيرة، انتظر قليلًا ثم أعد المحاولة' },
});

/**
 * POST /api/subscriptions/apple/verify
 *
 * body: { receipt: string, productId?: string, source?: 'purchase'|'restore' }
 */
router.post('/apple/verify', auth, verifyLimiter, async (req, res, next) => {
  try {
    const { receipt, productId, transactionId } = req.body || {};

    if (typeof receipt !== 'string' || receipt.length < 20) {
      return res.status(400).json({ message: 'إيصال غير صالح' });
    }

    // المنتجات الأساسية + أي منتج أضافه الأدمن في خطط الاشتراك
    const productPlan = productId
      ? (isKnownProduct(productId) ? { audience: 'family' } : await planForProduct(productId))
      : null;
    if (productId && !productPlan) {
      return res.status(400).json({ message: 'باقة غير معروفة' });
    }

    // اشتراك الأخصائي: يمدّد اشتراك ملف الأخصائي وليس اشتراك العائلة.
    if (productPlan?.audience === 'specialist') {
      return await verifySpecialist(req, res, { receipt, productId, transactionId });
    }

    const verified = await verifyAppleReceipt(receipt);

    if (!verified) {
      return res
        .status(400)
        .json({ message: 'لا يوجد اشتراك فعّال في هذا الإيصال' });
    }

    const subscription = await prisma.$transaction((tx) =>
      upsertAppleSubscription(req.user.id, verified, tx)
    );

    const hasAccess = subscription.status === 'active';

    return res.json({
      hasAccess,
      status: subscription.status,
      source: 'apple',
      productId: subscription.appleProductId,
      planName: subscription.planName,
      expiryDate: subscription.expiryDate,
      subscription,
    });
  } catch (error) {
    console.error('[apple-iap] verify failed:', error.message);

    if (error.statusCode === 409) {
      return res.status(409).json({ message: error.message });
    }

    // 21002 / 21003 / 21004 = إيصال أو مفتاح مشترك خاطئ
    if (error.appleStatus) {
      return res.status(400).json({ message: 'تعذر التحقق من الإيصال' });
    }

    if (error.statusCode === 502) {
      return res
        .status(502)
        .json({ message: 'تعذر الاتصال بخوادم آبل، حاول مرة أخرى' });
    }

    return next(error);
  }
});

async function verifySpecialist(req, res, { receipt, productId, transactionId }) {
  const profile = await prisma.specialistProfile.findUnique({ where: { userId: req.user.id } });
  if (!profile || !['APPROVED', 'PENDING'].includes(profile.status)) {
    return res.status(400).json({ message: 'قدّم طلب الانضمام كأخصائي أولًا' });
  }

  const verified = await verifySpecialistPurchase(receipt, { productId, transactionId });
  if (!verified) {
    return res.status(400).json({ message: 'لم يتم العثور على عملية الشراء' });
  }
  const productPlan = await planForProduct(verified.productId);
  if (productPlan?.audience !== 'specialist') {
    return res.status(400).json({ message: 'هذه العملية ليست اشتراك أخصائي' });
  }
  if (verified.isCancelled) {
    return res.status(400).json({ message: 'تم استرجاع هذه العملية من آبل' });
  }

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.appleSpecialistPurchase.findUnique({
      where: { transactionId: verified.transactionId },
    });
    if (existing) {
      if (existing.userId !== req.user.id) {
        const error = new Error('عملية الشراء هذه مرتبطة بحساب آخر');
        error.statusCode = 409;
        throw error;
      }
      // سبق احتسابها (إعادة إرسال أو استعادة)
      return tx.specialistProfile.findUnique({ where: { id: profile.id } });
    }

    const current = await tx.specialistProfile.findUnique({ where: { id: profile.id } });
    const now = new Date();
    const base = current.subscriptionExpiry && current.subscriptionExpiry > now
      ? current.subscriptionExpiry
      : now;
    let expiresAt;
    if (verified.expiresAt) {
      // متجدد تلقائيًا: آبل تحدد تاريخ الانتهاء
      expiresAt = verified.expiresAt > base ? verified.expiresAt : base;
    } else {
      // غير متجدد: المدة من خطة السيرفر (مثل 45 يومًا)، تُضاف للاشتراك الحالي
      const { plan } = productPlan;
      expiresAt = addPlanDuration(base, { type: plan.durationType, value: plan.durationValue });
    }

    await tx.appleSpecialistPurchase.create({
      data: {
        transactionId: verified.transactionId,
        originalTransactionId: verified.originalTransactionId,
        userId: req.user.id,
        specialistProfileId: profile.id,
        productId: verified.productId,
        expiresAt,
        environment: verified.environment || null,
      },
    });
    return tx.specialistProfile.update({
      where: { id: profile.id },
      data: { subscriptionExpiry: expiresAt },
    });
  });

  return res.json({
    specialist: true,
    source: 'apple',
    productId: verified.productId,
    expiryDate: result.subscriptionExpiry,
    specialistProfile: ownProfile(result),
  });
}

module.exports = router;
