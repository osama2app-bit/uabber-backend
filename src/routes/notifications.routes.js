const express = require('express');
const prisma = require('../config/prisma');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();

async function backfillPendingNotifications() {
  const [paymentRequests, consultations] = await Promise.all([
    prisma.paymentRequest.findMany({
      where: { status: 'PENDING' },
      select: { id: true, userName: true, packageName: true, createdAt: true },
    }),
    prisma.consultation.findMany({
      where: { status: 'NEW' },
      select: { id: true, userName: true, specialist: true, createdAt: true },
    }),
  ]);

  const operations = [];
  for (const request of paymentRequests) {
    operations.push(
      prisma.adminNotification.upsert({
        where: { type_sourceId: { type: 'subscription', sourceId: request.id } },
        update: {},
        create: {
          title: 'طلب اشتراك جديد',
          body: `${request.userName || 'مستخدم'} - ${request.packageName}`,
          type: 'subscription',
          sourceId: request.id,
          route: '/admin/subscriptions',
          createdAt: request.createdAt,
        },
      })
    );
  }

  for (const consultation of consultations) {
    operations.push(
      prisma.adminNotification.upsert({
        where: { type_sourceId: { type: 'consultation', sourceId: consultation.id } },
        update: {},
        create: {
          title: 'طلب استشارة جديد',
          body: `${consultation.userName || 'مستخدم'} - ${consultation.specialist}`,
          type: 'consultation',
          sourceId: consultation.id,
          route: '/admin/consultations',
          createdAt: consultation.createdAt,
        },
      })
    );
  }

  if (operations.length) await prisma.$transaction(operations);
}

router.get('/', auth, adminOnly, async (req, res, next) => {
  try {
    await backfillPendingNotifications();
    const notifications = await prisma.adminNotification.findMany({
      orderBy: [{ isRead: 'asc' }, { createdAt: 'desc' }],
    });
    res.json(notifications);
  } catch (error) {
    next(error);
  }
});

router.get('/summary', auth, adminOnly, async (req, res, next) => {
  try {
    await backfillPendingNotifications();
    const [unread, pendingSubscriptions, pendingConsultations] = await Promise.all([
      prisma.adminNotification.count({ where: { isRead: false } }),
      prisma.paymentRequest.count({ where: { status: 'PENDING' } }),
      prisma.consultation.count({ where: { status: 'NEW' } }),
    ]);
    res.json({ unread, pendingSubscriptions, pendingConsultations });
  } catch (error) {
    next(error);
  }
});

router.patch('/read-all', auth, adminOnly, async (req, res, next) => {
  try {
    const result = await prisma.adminNotification.updateMany({
      where: { isRead: false },
      data: { isRead: true },
    });
    res.json({ ok: true, updated: result.count });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/read', auth, adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Invalid notification id' });
    }
    const notification = await prisma.adminNotification.update({
      where: { id },
      data: { isRead: true },
    });
    res.json(notification);
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ message: 'Notification not found' });
    next(error);
  }
});

module.exports = router;
