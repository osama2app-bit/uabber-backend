const express = require('express');
const prisma = require('../config/prisma');
const { auth, adminOnly } = require('../middleware/auth');
const { makeUpload, fileUrl } = require('../utils/upload');

const router = express.Router();

const ACTIVE = 'active';
const EXPIRED = 'expired';
const CANCELLED = 'cancelled';

function parsePlanMonths(packageName) {
  const name = String(packageName || '').trim().toLowerCase();

  if (name.includes('سنة') || name.includes('سنوي') || name.includes('year')) {
    return 12;
  }

  if (
    name.includes('6') ||
    name.includes('ستة') ||
    name.includes('ست شهور') ||
    name.includes('six')
  ) {
    return 6;
  }

  if (
    name.includes('شهر') ||
    name.includes('شهري') ||
    name.includes('month')
  ) {
    return 1;
  }

  return null;
}

// Adds months without turning January 31 + 1 month into a date in March.
function addMonthsClamped(date, months) {
  const result = new Date(date);
  const originalDay = result.getUTCDate();

  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);

  const lastDayOfTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
  ).getUTCDate();

  result.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));
  return result;
}

async function expireStaleSubscriptions(userId, tx = prisma) {
  const now = new Date();

  await tx.subscription.updateMany({
    where: {
      ...(userId ? { userId } : {}),
      status: ACTIVE,
      expiryDate: { lte: now },
    },
    data: { status: EXPIRED },
  });
}

async function getAccessState(user, tx = prisma) {
  if (user.role === 'ADMIN') {
    return {
      hasAccess: true,
      source: 'admin',
      status: ACTIVE,
      expiryDate: null,
      daysRemaining: null,
      subscription: null,
    };
  }

  await expireStaleSubscriptions(user.id, tx);

  const now = new Date();
  const subscription = await tx.subscription.findFirst({
    where: {
      userId: user.id,
      status: ACTIVE,
      expiryDate: { gt: now },
    },
    orderBy: { expiryDate: 'desc' },
  });

  if (subscription) {
    return {
      hasAccess: true,
      source: 'subscription',
      status: ACTIVE,
      expiryDate: subscription.expiryDate,
      daysRemaining: Math.max(
        0,
        Math.ceil((subscription.expiryDate.getTime() - now.getTime()) / 86400000)
      ),
      subscription,
    };
  }

  const trialActive = user.trialExpiryDate && user.trialExpiryDate > now;

  return {
    hasAccess: Boolean(trialActive),
    source: trialActive ? 'trial' : 'none',
    status: trialActive ? ACTIVE : EXPIRED,
    expiryDate: user.trialExpiryDate || null,
    daysRemaining: trialActive
      ? Math.max(
          0,
          Math.ceil((user.trialExpiryDate.getTime() - now.getTime()) / 86400000)
        )
      : 0,
    subscription: null,
  };
}

router.post(
  '/payment-requests',
  auth,
  makeUpload('receipts', 'receipt'),
  async (req, res, next) => {
    try {
      const packageName = String(req.body.packageName || '').trim();
      const price = String(req.body.price || '').trim();
      const months = parsePlanMonths(packageName);

      if (!packageName || !price || !req.file) {
        return res.status(400).json({
          message: 'packageName, price and receipt are required',
        });
      }

      if (!months) {
        return res.status(400).json({ message: 'Unsupported subscription plan' });
      }

      const existingPending = await prisma.paymentRequest.findFirst({
        where: {
          userId: req.user.id,
          status: 'PENDING',
          packageName,
        },
        orderBy: { createdAt: 'desc' },
      });

      if (existingPending) {
        return res.status(409).json({
          message: 'A pending payment request already exists for this plan',
          paymentRequest: existingPending,
        });
      }

      const receiptUrl = await fileUrl(req, 'receipts', req.file);
      const paymentRequest = await prisma.paymentRequest.create({
        data: {
          userId: req.user.id,
          userName: req.user.fullName,
          userEmail: req.user.email,
          packageName,
          price,
          receiptUrl,
        },
      });

      return res.status(201).json(paymentRequest);
    } catch (error) {
      return next(error);
    }
  }
);

router.get('/payment-requests', auth, adminOnly, async (req, res, next) => {
  try {
    const requests = await prisma.paymentRequest.findMany({
      orderBy: { id: 'desc' },
      include: {
        user: {
          select: { id: true, fullName: true, email: true, isActive: true },
        },
        subscription: true,
      },
    });

    return res.json(requests);
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/payment-requests/:id/approve',
  auth,
  adminOnly,
  async (req, res, next) => {
    try {
      const requestId = Number(req.params.id);
      if (!Number.isInteger(requestId) || requestId <= 0) {
        return res.status(400).json({ message: 'Invalid payment request id' });
      }

      const result = await prisma.$transaction(async (tx) => {
        const paymentRequest = await tx.paymentRequest.findUnique({
          where: { id: requestId },
          include: { subscription: true },
        });

        if (!paymentRequest) {
          const error = new Error('Payment request not found');
          error.statusCode = 404;
          throw error;
        }

        // Safe retry: approving the same request twice never adds time twice.
        if (paymentRequest.status === 'APPROVED') {
          if (paymentRequest.subscription) {
            return {
              alreadyApproved: true,
              paymentRequest,
              subscription: paymentRequest.subscription,
            };
          }

          const error = new Error(
            'This request is approved but has no linked subscription. Review the database record.'
          );
          error.statusCode = 409;
          throw error;
        }

        if (paymentRequest.status === 'REJECTED') {
          const error = new Error('Rejected payment requests cannot be approved');
          error.statusCode = 409;
          throw error;
        }

        const months = parsePlanMonths(paymentRequest.packageName);
        if (!months) {
          const error = new Error('Unsupported subscription plan');
          error.statusCode = 400;
          throw error;
        }

        await expireStaleSubscriptions(paymentRequest.userId, tx);

        const now = new Date();
        const currentActive = await tx.subscription.findFirst({
          where: {
            userId: paymentRequest.userId,
            status: ACTIVE,
            expiryDate: { gt: now },
          },
          orderBy: { expiryDate: 'desc' },
        });

        // Extend from the current expiry if the user renews early.
        const extensionBase =
          currentActive && currentActive.expiryDate > now
            ? currentActive.expiryDate
            : now;
        const expiryDate = addMonthsClamped(extensionBase, months);

        // Keep exactly one active subscription row per user.
        await tx.subscription.updateMany({
          where: { userId: paymentRequest.userId, status: ACTIVE },
          data: { status: EXPIRED },
        });

        const subscription = await tx.subscription.create({
          data: {
            userId: paymentRequest.userId,
            paymentRequestId: paymentRequest.id,
            status: ACTIVE,
            planName: paymentRequest.packageName,
            planMonths: months,
            amount: paymentRequest.price,
            startDate: now,
            expiryDate,
          },
        });

        const approvedRequest = await tx.paymentRequest.update({
          where: { id: paymentRequest.id },
          data: {
            status: 'APPROVED',
            decidedAt: now,
          },
        });

        return {
          alreadyApproved: false,
          paymentRequest: approvedRequest,
          subscription,
        };
      });

      return res.json({ ok: true, ...result });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ message: error.message });
      }
      return next(error);
    }
  }
);

router.post(
  '/payment-requests/:id/reject',
  auth,
  adminOnly,
  async (req, res, next) => {
    try {
      const requestId = Number(req.params.id);
      if (!Number.isInteger(requestId) || requestId <= 0) {
        return res.status(400).json({ message: 'Invalid payment request id' });
      }

      const paymentRequest = await prisma.paymentRequest.findUnique({
        where: { id: requestId },
      });

      if (!paymentRequest) {
        return res.status(404).json({ message: 'Payment request not found' });
      }

      if (paymentRequest.status === 'APPROVED') {
        return res.status(409).json({
          message: 'Approved payment requests cannot be rejected',
        });
      }

      if (paymentRequest.status === 'REJECTED') {
        return res.json({ ok: true, alreadyRejected: true, paymentRequest });
      }

      const rejected = await prisma.paymentRequest.update({
        where: { id: requestId },
        data: { status: 'REJECTED', decidedAt: new Date() },
      });

      return res.json({ ok: true, alreadyRejected: false, paymentRequest: rejected });
    } catch (error) {
      return next(error);
    }
  }
);

router.get('/me', auth, async (req, res, next) => {
  try {
    const access = await getAccessState(req.user);
    return res.json(access);
  } catch (error) {
    return next(error);
  }
});

router.get('/history', auth, async (req, res, next) => {
  try {
    await expireStaleSubscriptions(req.user.id);

    const subscriptions = await prisma.subscription.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        paymentRequest: {
          select: {
            id: true,
            packageName: true,
            price: true,
            status: true,
            createdAt: true,
            decidedAt: true,
          },
        },
      },
    });

    return res.json(subscriptions);
  } catch (error) {
    return next(error);
  }
});

router.get('/admin/all', auth, adminOnly, async (req, res, next) => {
  try {
    await expireStaleSubscriptions(null);

    const subscriptions = await prisma.subscription.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { id: true, fullName: true, email: true, isActive: true },
        },
        paymentRequest: true,
      },
    });

    return res.json(subscriptions);
  } catch (error) {
    return next(error);
  }
});

router.post('/:id/cancel', auth, adminOnly, async (req, res, next) => {
  try {
    const subscriptionId = Number(req.params.id);
    if (!Number.isInteger(subscriptionId) || subscriptionId <= 0) {
      return res.status(400).json({ message: 'Invalid subscription id' });
    }

    const subscription = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
    });

    if (!subscription) {
      return res.status(404).json({ message: 'Subscription not found' });
    }

    const cancelled = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: { status: CANCELLED },
    });

    return res.json({ ok: true, subscription: cancelled });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
module.exports.getAccessState = getAccessState;
module.exports.expireStaleSubscriptions = expireStaleSubscriptions;
