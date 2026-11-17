// إشعارات المستخدم: تسجيل الأجهزة (FCM) وسجل الإشعارات داخل التطبيق.
const express = require('express');
const prisma = require('../config/prisma');
const { auth } = require('../middleware/auth');

const router = express.Router();
const PLATFORMS = new Set(['android', 'ios', 'web']);

// تسجيل/تحديث رمز الجهاز بعد تسجيل الدخول أو عند تجديد الرمز
router.post('/devices', auth, async (req, res, next) => {
  try {
    const token = String(req.body.token || '').trim();
    const platform = String(req.body.platform || '').toLowerCase();
    if (token.length < 20 || token.length > 4096) return res.status(400).json({ message: 'رمز الجهاز غير صالح' });
    if (!PLATFORMS.has(platform)) return res.status(400).json({ message: 'نوع الجهاز غير صالح' });
    // الرمز ينتقل للمستخدم الحالي إن سجّل شخص آخر دخوله على نفس الجهاز
    const device = await prisma.deviceToken.upsert({
      where: { token },
      create: { token, platform, userId: req.user.id },
      update: { platform, userId: req.user.id, lastSeenAt: new Date() },
    });
    return res.status(201).json({ id: device.id, platform: device.platform });
  } catch (error) {
    return next(error);
  }
});

// إزالة الجهاز عند تسجيل الخروج
router.delete('/devices', auth, async (req, res, next) => {
  try {
    const token = String(req.body?.token || req.query.token || '').trim();
    const r = await prisma.deviceToken.deleteMany({ where: { token, userId: req.user.id } });
    return res.json({ removed: r.count });
  } catch (error) {
    return next(error);
  }
});

const PUBLIC_FIELDS = {
  id: true, type: true, title: true, body: true, data: true, consultationId: true,
  scheduledAt: true, status: true, sentAt: true, readAt: true, createdAt: true,
};

// سجل إشعاراتي (المستحقة فقط، بدون التذكيرات المستقبلية أو الملغاة)
router.get('/mine', auth, async (req, res, next) => {
  try {
    const rows = await prisma.userNotification.findMany({
      where: { userId: req.user.id, scheduledAt: { lte: new Date() }, status: { not: 'CANCELLED' } },
      orderBy: { scheduledAt: 'desc' },
      take: 50,
      select: PUBLIC_FIELDS,
    });
    const unread = await prisma.userNotification.count({
      where: { userId: req.user.id, readAt: null, scheduledAt: { lte: new Date() }, status: { not: 'CANCELLED' } },
    });
    return res.json({ items: rows, unread });
  } catch (error) {
    return next(error);
  }
});

router.post('/mine/read-all', auth, async (req, res, next) => {
  try {
    const r = await prisma.userNotification.updateMany({
      where: { userId: req.user.id, readAt: null, scheduledAt: { lte: new Date() } },
      data: { readAt: new Date() },
    });
    return res.json({ updated: r.count });
  } catch (error) {
    return next(error);
  }
});

router.post('/mine/:id/read', auth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const r = await prisma.userNotification.updateMany({
      where: { id, userId: req.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return res.json({ updated: r.count });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
