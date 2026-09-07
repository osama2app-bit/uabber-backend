const express = require('express');
const rateLimit = require('express-rate-limit');
const prisma = require('../config/prisma');
const { auth } = require('../middleware/auth');
const {
  isKnownProduct,
  verifyAppleReceipt,
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
    const { receipt, productId } = req.body || {};

    if (typeof receipt !== 'string' || receipt.length < 20) {
      return res.status(400).json({ message: 'إيصال غير صالح' });
    }

    if (productId && !isKnownProduct(productId)) {
      return res.status(400).json({ message: 'باقة غير معروفة' });
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

module.exports = router;
