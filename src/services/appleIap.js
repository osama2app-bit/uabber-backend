const fs = require('fs');
const path = require('path');
const prisma = require('../config/prisma');

const {
  SignedDataVerifier,
  Environment,
} = require('@apple/app-store-server-library');

const BUNDLE_ID =
  process.env.APPLE_BUNDLE_ID || 'com.uabber.learn';

const APPLE_APP_ID = Number(process.env.APPLE_APP_ID || 0);

const ACTIVE = 'active';
const EXPIRED = 'expired';

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

const RECHECK_INTERVAL_MS = 15 * 60 * 1000;

function isKnownProduct(productId) {
  return Object.prototype.hasOwnProperty.call(
    APPLE_PLANS,
    productId
  );
}

/**
 * هل القيمة JWS من StoreKit 2؟
 *
 * JWS يتكون من:
 * header.payload.signature
 */
function isJws(value) {
  return (
    typeof value === 'string' &&
    value.split('.').length === 3
  );
}

/**
 * تحميل شهادات Apple الجذرية.
 *
 * - يتجاهل أي شهادة غير موجودة بدل ما يفشل.
 * - يفشل فقط إذا ما في ولا شهادة.
 * - G3 هي الأهم لـ StoreKit 2.
 * - النتيجة تنحفظ بالذاكرة عشان ما نقرأ الملفات كل طلب.
 */
let cachedAppleRoots = null;

function loadAppleRootCertificates() {
  if (cachedAppleRoots) {
    return cachedAppleRoots;
  }

  const files = [
    process.env.APPLE_ROOT_CA_G2_PATH ||
      './certs/AppleRootCA-G2.cer',

    process.env.APPLE_ROOT_CA_G3_PATH ||
      './certs/AppleRootCA-G3.cer',

    process.env.APPLE_INC_ROOT_PATH ||
      './certs/AppleIncRootCertificate.cer',

    process.env.APPLE_COMPUTER_ROOT_PATH ||
      './certs/AppleComputerRootCertificate.cer',
  ];

  const roots = [];
  const missing = [];

  for (const file of files) {
    const resolved = path.isAbsolute(file)
      ? file
      : path.resolve(process.cwd(), file);

    if (fs.existsSync(resolved)) {
      roots.push(fs.readFileSync(resolved));
    } else {
      missing.push(resolved);
    }
  }

  if (missing.length) {
    console.warn(
      `[apple-iap] Skipping missing Apple root certificates: ${missing.join(', ')}`
    );
  }

  if (roots.length === 0) {
    throw new Error(
      'No Apple root certificates found. Add AppleRootCA-G3.cer to the certs folder.'
    );
  }

  cachedAppleRoots = roots;
  return roots;
}

/**
 * إنشاء verifier لـ Sandbox.
 */
function createSandboxVerifier() {
  const roots = loadAppleRootCertificates();

  return new SignedDataVerifier(
    roots,
    true,
    Environment.SANDBOX,
    BUNDLE_ID
  );
}

/**
 * إنشاء verifier للإنتاج.
 */
function createProductionVerifier() {
  if (!APPLE_APP_ID) {
    throw new Error(
      'APPLE_APP_ID is required for Production Apple verification'
    );
  }

  const roots = loadAppleRootCertificates();

  return new SignedDataVerifier(
    roots,
    true,
    Environment.PRODUCTION,
    BUNDLE_ID,
    APPLE_APP_ID
  );
}

/**
 * التحقق من JWS القادم من Flutter / StoreKit 2.
 *
 * نحاول Sandbox أولًا ثم Production.
 */
async function verifyAppleJws(jws) {
  let sandboxError = null;

  try {
    const verifier = createSandboxVerifier();

    const transaction =
      await verifier.verifyAndDecodeTransaction(jws);

    return {
      ...transaction,
      environment: 'Sandbox',
    };
  } catch (error) {
    sandboxError = error;
  }

  try {
    const verifier = createProductionVerifier();

    const transaction =
      await verifier.verifyAndDecodeTransaction(jws);

    return {
      ...transaction,
      environment: 'Production',
    };
  } catch (productionError) {
    const error = new Error(
      `Apple JWS verification failed. ` +
        `Sandbox: ${sandboxError?.message || 'unknown'} | ` +
        `Production: ${productionError?.message || 'unknown'}`
    );

    error.statusCode = 400;

    throw error;
  }
}

/**
 * التحقق من عملية Apple.
 *
 * يدعم:
 * 1. StoreKit 2 JWS
 * 2. Receipt القديم في حال كان موجودًا.
 */
async function verifyAppleReceipt(receipt) {
  if (!receipt) {
    const error = new Error(
      'Apple purchase verification data is empty'
    );

    error.statusCode = 400;

    throw error;
  }

  /**
   * StoreKit 2
   */
  if (isJws(receipt)) {
    const transaction = await verifyAppleJws(receipt);

    const productId = transaction.productId;

    if (!isKnownProduct(productId)) {
      const error = new Error(
        `Unknown Apple product: ${productId}`
      );

      error.statusCode = 400;

      throw error;
    }

    const expiresMs = Number(
      transaction.expiresDate || 0
    );

    if (!expiresMs) {
      const error = new Error(
        'Apple transaction has no expiration date'
      );

      error.statusCode = 400;

      throw error;
    }

    return {
      expiresAt: new Date(expiresMs),

      productId,

      originalTransactionId: String(
        transaction.originalTransactionId
      ),

      transactionId: String(
        transaction.transactionId
      ),

      isCancelled:
        transaction.revocationDate != null,

      environment: transaction.environment,

      /**
       * StoreKit 2 does not provide the old
       * latest_receipt format.
       *
       * Keep the JWS so we know this is a StoreKit 2
       * transaction.
       */
      latestReceipt: receipt,
    };
  }

  /**
   * Legacy receipt support.
   *
   * هذا الجزء يبقى فقط لدعم receipts القديمة.
   */
  return verifyLegacyAppleReceipt(receipt);
}

/**
 * التحقق القديم باستخدام verifyReceipt.
 *
 * هذا ليس المسار المستخدم مع StoreKit 2.
 */
async function verifyLegacyAppleReceipt(receipt) {
  if (!process.env.APPLE_SHARED_SECRET) {
    const error = new Error(
      'APPLE_SHARED_SECRET is not configured'
    );

    error.statusCode = 500;

    throw error;
  }

  const PROD_URL =
    'https://buy.itunes.apple.com/verifyReceipt';

  const SANDBOX_URL =
    'https://sandbox.itunes.apple.com/verifyReceipt';

  async function callApple(url) {
    const response = await fetch(url, {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
      },

      body: JSON.stringify({
        'receipt-data': receipt,

        password:
          process.env.APPLE_SHARED_SECRET,

        'exclude-old-transactions': true,
      }),
    });

    if (!response.ok) {
      const error = new Error(
        `Apple HTTP ${response.status}`
      );

      error.statusCode = 502;

      throw error;
    }

    return response.json();
  }

  let data =
    await callApple(PROD_URL);

  let environment = 'Production';

  if (data.status === 21007) {
    data =
      await callApple(SANDBOX_URL);

    environment = 'Sandbox';
  }

  if (data.status !== 0) {
    const error = new Error(
      `Apple receipt status ${data.status}`
    );

    error.appleStatus = data.status;
    error.statusCode = 400;

    throw error;
  }

  const bundleId =
    data.receipt &&
    data.receipt.bundle_id;

  if (bundleId !== BUNDLE_ID) {
    const error = new Error(
      `Bundle mismatch: ${bundleId}`
    );

    error.statusCode = 400;

    throw error;
  }

  const items =
    Array.isArray(data.latest_receipt_info)
      ? data.latest_receipt_info
      : [];

  let best = null;

  for (const item of items) {
    if (!isKnownProduct(item.product_id)) {
      continue;
    }

    const expiresMs =
      Number(item.expires_date_ms || 0);

    if (!expiresMs) {
      continue;
    }

    if (
      !best ||
      expiresMs >
        best.expiresAt.getTime()
    ) {
      best = {
        expiresAt:
          new Date(expiresMs),

        productId:
          item.product_id,

        originalTransactionId:
          String(
            item.original_transaction_id
          ),

        transactionId:
          String(
            item.transaction_id
          ),

        isCancelled:
          Boolean(
            item.cancellation_date_ms
          ),
      };
    }
  }

  if (!best) {
    return null;
  }

  return {
    ...best,

    environment,

    latestReceipt:
      data.latest_receipt || receipt,
  };
}

/**
 * حفظ الاشتراك في قاعدة البيانات.
 */
async function upsertAppleSubscription(
  userId,
  verified,
  tx = prisma
) {
  const plan =
    APPLE_PLANS[verified.productId] || {
      planName: verified.productId,
      planMonths: null,
    };

  const isActive =
    !verified.isCancelled &&
    verified.expiresAt.getTime() >
      Date.now();

  const existing =
    await tx.subscription.findUnique({
      where: {
        appleOriginalTransactionId:
          verified.originalTransactionId,
      },
    });

  if (
    existing &&
    existing.userId !== userId
  ) {
    const error = new Error(
      'هذا الاشتراك مرتبط بحساب آخر. سجّل الدخول بذلك الحساب.'
    );

    error.statusCode = 409;

    throw error;
  }

  const data = {
    status: isActive
      ? ACTIVE
      : EXPIRED,

    planName:
      plan.planName,

    planMonths:
      plan.planMonths,

    amount: null,

    expiryDate:
      verified.expiresAt,

    provider:
      'apple',

    appleProductId:
      verified.productId,

    appleLatestReceipt:
      verified.latestReceipt,

    appleEnvironment:
      verified.environment,

    appleLastCheckedAt:
      new Date(),
  };

  if (existing) {
    return tx.subscription.update({
      where: {
        id: existing.id,
      },

      data,
    });
  }

  return tx.subscription.create({
    data: {
      ...data,

      userId,

      startDate:
        new Date(),

      appleOriginalTransactionId:
        verified.originalTransactionId,
    },
  });
}

/**
 * إعادة التحقق من الاشتراكات القديمة.
 */
async function refreshAppleSubscriptions(
  userId,
  tx = prisma
) {
  if (!userId) {
    return;
  }

  const now =
    new Date();

  const recheckBefore =
    new Date(
      now.getTime() -
        RECHECK_INTERVAL_MS
    );

  const candidates =
    await tx.subscription.findMany({
      where: {
        userId,

        provider:
          'apple',

        appleLatestReceipt: {
          not: null,
        },

        expiryDate: {
          lte: now,
        },

        OR: [
          {
            appleLastCheckedAt:
              null,
          },

          {
            appleLastCheckedAt: {
              lte:
                recheckBefore,
            },
          },
        ],
      },
    });

  for (const subscription of candidates) {
    try {
      /**
       * إذا كان المخزن JWS من StoreKit 2،
       * نعيد التحقق منه.
       */
      const verified =
        await verifyAppleReceipt(
          subscription.appleLatestReceipt
        );

      if (!verified) {
        await tx.subscription.update({
          where: {
            id: subscription.id,
          },

          data: {
            appleLastCheckedAt:
              new Date(),
          },
        });

        continue;
      }

      await upsertAppleSubscription(
        userId,
        verified,
        tx
      );
    } catch (error) {
      console.error(
        `[apple-iap] refresh failed for subscription ${subscription.id}:`,
        error.message
      );

      await tx.subscription
        .update({
          where: {
            id: subscription.id,
          },

          data: {
            appleLastCheckedAt:
              new Date(),
          },
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