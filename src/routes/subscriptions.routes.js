const express = require('express');
const prisma = require('../config/prisma');
const { auth, adminOnly } = require('../middleware/auth');
const { makeUpload, fileUrl } = require('../utils/upload');

const router = express.Router();

const ACTIVE = 'active';
const EXPIRED = 'expired';
const CANCELLED = 'cancelled';

/**
 * تحديد مدة الباقة من اسمها.
 *
 * باقة اليوم الواحد:
 * type = days
 * value = 1
 * planMonths = 0
 *
 * الباقات الأخرى:
 * type = months
 * value = عدد الأشهر
 */
function parsePlanDuration(packageName) {
  const name = String(packageName || '')
    .trim()
    .toLowerCase();

  if (
    name.includes('يوم واحد') ||
    name.includes('يوم للتجربة') ||
    name.includes('يوم تجريبي') ||
    name.includes('one day') ||
    name.includes('1 day')
  ) {
    return {
      type: 'days',
      value: 1,
      planMonths: 0,
    };
  }

  if (
    name.includes('سنة') ||
    name.includes('سنوي') ||
    name.includes('year')
  ) {
    return {
      type: 'months',
      value: 12,
      planMonths: 12,
    };
  }

  if (
    name.includes('6') ||
    name.includes('ستة') ||
    name.includes('ست شهور') ||
    name.includes('six')
  ) {
    return {
      type: 'months',
      value: 6,
      planMonths: 6,
    };
  }

  if (
    name.includes('شهر') ||
    name.includes('شهري') ||
    name.includes('month')
  ) {
    return {
      type: 'months',
      value: 1,
      planMonths: 1,
    };
  }

  return null;
}

/**
 * إضافة عدد أشهر مع منع مشكلة:
 * 31 يناير + شهر = تاريخ غير صحيح في مارس.
 */
function addMonthsClamped(date, months) {
  const result = new Date(date);
  const originalDay = result.getUTCDate();

  result.setUTCDate(1);
  result.setUTCMonth(
    result.getUTCMonth() + months
  );

  const lastDayOfTargetMonth = new Date(
    Date.UTC(
      result.getUTCFullYear(),
      result.getUTCMonth() + 1,
      0
    )
  ).getUTCDate();

  result.setUTCDate(
    Math.min(
      originalDay,
      lastDayOfTargetMonth
    )
  );

  return result;
}

/**
 * إضافة مدة الباقة سواء كانت يومًا أو أشهرًا.
 */
function addPlanDuration(date, duration) {
  if (!duration) {
    throw new Error(
      'Invalid subscription duration'
    );
  }

  if (duration.type === 'days') {
    const result = new Date(date);

    result.setUTCDate(
      result.getUTCDate() + duration.value
    );

    return result;
  }

  if (duration.type === 'months') {
    return addMonthsClamped(
      date,
      duration.value
    );
  }

  throw new Error(
    'Unsupported subscription duration'
  );
}

/**
 * تحويل الاشتراكات المنتهية إلى expired.
 */
async function expireStaleSubscriptions(
  userId,
  tx = prisma
) {
  const now = new Date();

  await tx.subscription.updateMany({
    where: {
      ...(userId ? { userId } : {}),
      status: ACTIVE,
      expiryDate: {
        lte: now,
      },
    },
    data: {
      status: EXPIRED,
    },
  });
}

/**
 * إرجاع حالة وصول المستخدم.
 */
async function getAccessState(
  user,
  tx = prisma
) {
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

  await expireStaleSubscriptions(
    user.id,
    tx
  );

  const now = new Date();

  const subscription =
    await tx.subscription.findFirst({
      where: {
        userId: user.id,
        status: ACTIVE,
        expiryDate: {
          gt: now,
        },
      },
      orderBy: {
        expiryDate: 'desc',
      },
    });

  if (subscription) {
    return {
      hasAccess: true,
      source: 'subscription',
      status: ACTIVE,
      expiryDate:
        subscription.expiryDate,
      daysRemaining: Math.max(
        0,
        Math.ceil(
          (
            subscription.expiryDate
              .getTime() -
            now.getTime()
          ) /
            86400000
        )
      ),
      subscription,
    };
  }

  const trialActive =
    user.trialExpiryDate &&
    user.trialExpiryDate > now;

  return {
    hasAccess: Boolean(trialActive),
    source: trialActive
      ? 'trial'
      : 'none',
    status: trialActive
      ? ACTIVE
      : EXPIRED,
    expiryDate:
      user.trialExpiryDate || null,
    daysRemaining: trialActive
      ? Math.max(
          0,
          Math.ceil(
            (
              user.trialExpiryDate
                .getTime() -
              now.getTime()
            ) /
              86400000
          )
        )
      : 0,
    subscription: null,
  };
}

/**
 * إنشاء طلب دفع جديد.
 */
router.post(
  '/payment-requests',
  auth,
  makeUpload(
    'receipts',
    'receipt'
  ),
  async (req, res, next) => {
    try {
      const packageName = String(
        req.body.packageName || ''
      ).trim();

      const price = String(
        req.body.price || ''
      ).trim();

      const duration =
        parsePlanDuration(
          packageName
        );

      if (
        !packageName ||
        !price ||
        !req.file
      ) {
        return res
          .status(400)
          .json({
            message:
              'packageName, price and receipt are required',
          });
      }

      if (!duration) {
        return res
          .status(400)
          .json({
            message:
              'Unsupported subscription plan',
          });
      }

      const existingPending =
        await prisma.paymentRequest
          .findFirst({
            where: {
              userId:
                req.user.id,
              status:
                'PENDING',
              packageName,
            },
            orderBy: {
              createdAt:
                'desc',
            },
          });

      if (existingPending) {
        return res
          .status(409)
          .json({
            message:
              'A pending payment request already exists for this plan',
            paymentRequest:
              existingPending,
          });
      }

      const receiptUrl =
        await fileUrl(
          req,
          'receipts',
          req.file
        );

      const paymentRequest =
        await prisma.$transaction(
          async (tx) => {
            const created =
              await tx.paymentRequest
                .create({
                  data: {
                    userId:
                      req.user.id,
                    userName:
                      req.user
                        .fullName,
                    userEmail:
                      req.user
                        .email,
                    packageName,
                    price,
                    receiptUrl,
                  },
                });

            await tx.adminNotification
              .create({
                data: {
                  title:
                    'طلب اشتراك جديد',
                  body:
                    `${req.user.fullName} - ${packageName}`,
                  type:
                    'subscription',
                  sourceId:
                    created.id,
                  route:
                    '/admin/subscriptions',
                },
              });

            return created;
          }
        );

      return res
        .status(201)
        .json(
          paymentRequest
        );
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * جميع طلبات الدفع للأدمن.
 */
router.get(
  '/payment-requests',
  auth,
  adminOnly,
  async (req, res, next) => {
    try {
      const requests =
        await prisma.paymentRequest
          .findMany({
            orderBy: {
              id: 'desc',
            },
            include: {
              user: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                  isActive: true,
                },
              },
              subscription: true,
            },
          });

      return res.json(requests);
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * الموافقة على طلب الدفع وإنشاء الاشتراك.
 */
router.post(
  '/payment-requests/:id/approve',
  auth,
  adminOnly,
  async (req, res, next) => {
    try {
      const requestId = Number(
        req.params.id
      );

      if (
        !Number.isInteger(
          requestId
        ) ||
        requestId <= 0
      ) {
        return res
          .status(400)
          .json({
            message:
              'Invalid payment request id',
          });
      }

      const result =
        await prisma.$transaction(
          async (tx) => {
            const paymentRequest =
              await tx.paymentRequest
                .findUnique({
                  where: {
                    id: requestId,
                  },
                  include: {
                    subscription:
                      true,
                  },
                });

            if (!paymentRequest) {
              const error =
                new Error(
                  'Payment request not found'
                );

              error.statusCode =
                404;

              throw error;
            }

            /*
             * منع إضافة المدة مرتين إذا ضغط
             * الأدمن الموافقة مرتين.
             */
            if (
              paymentRequest.status ===
              'APPROVED'
            ) {
              if (
                paymentRequest
                  .subscription
              ) {
                return {
                  alreadyApproved:
                    true,
                  paymentRequest,
                  subscription:
                    paymentRequest
                      .subscription,
                };
              }

              const error =
                new Error(
                  'This request is approved but has no linked subscription. Review the database record.'
                );

              error.statusCode =
                409;

              throw error;
            }

            if (
              paymentRequest.status ===
              'REJECTED'
            ) {
              const error =
                new Error(
                  'Rejected payment requests cannot be approved'
                );

              error.statusCode =
                409;

              throw error;
            }

            const duration =
              parsePlanDuration(
                paymentRequest
                  .packageName
              );

            if (!duration) {
              const error =
                new Error(
                  'Unsupported subscription plan'
                );

              error.statusCode =
                400;

              throw error;
            }

            await expireStaleSubscriptions(
              paymentRequest.userId,
              tx
            );

            const now =
              new Date();

            const currentActive =
              await tx.subscription
                .findFirst({
                  where: {
                    userId:
                      paymentRequest
                        .userId,
                    status:
                      ACTIVE,
                    expiryDate: {
                      gt: now,
                    },
                  },
                  orderBy: {
                    expiryDate:
                      'desc',
                  },
                });

            /*
             * إذا كان لديه اشتراك فعال،
             * تضاف الباقة فوق تاريخ انتهائه.
             *
             * إذا لم يكن لديه اشتراك فعال،
             * تبدأ الباقة من الوقت الحالي.
             */
            const extensionBase =
              currentActive &&
              currentActive
                  .expiryDate >
                now
                ? currentActive
                    .expiryDate
                : now;

            const expiryDate =
              addPlanDuration(
                extensionBase,
                duration
              );

            /*
             * الإبقاء على اشتراك فعال واحد فقط.
             */
            await tx.subscription
              .updateMany({
                where: {
                  userId:
                    paymentRequest
                      .userId,
                  status:
                    ACTIVE,
                },
                data: {
                  status:
                    EXPIRED,
                },
              });

            const subscription =
              await tx.subscription
                .create({
                  data: {
                    userId:
                      paymentRequest
                        .userId,
                    paymentRequestId:
                      paymentRequest
                        .id,
                    status:
                      ACTIVE,
                    planName:
                      paymentRequest
                        .packageName,
                    planMonths:
                      duration
                        .planMonths,
                    amount:
                      paymentRequest
                        .price,
                    startDate:
                      now,
                    expiryDate,
                  },
                });

            const approvedRequest =
              await tx.paymentRequest
                .update({
                  where: {
                    id:
                      paymentRequest
                        .id,
                  },
                  data: {
                    status:
                      'APPROVED',
                    decidedAt:
                      now,
                  },
                });

            await tx.adminNotification
              .deleteMany({
                where: {
                  type:
                    'subscription',
                  sourceId:
                    paymentRequest
                      .id,
                },
              });

            return {
              alreadyApproved:
                false,
              paymentRequest:
                approvedRequest,
              subscription,
            };
          }
        );

      return res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      if (error.statusCode) {
        return res
          .status(
            error.statusCode
          )
          .json({
            message:
              error.message,
          });
      }

      return next(error);
    }
  }
);

/**
 * رفض طلب الدفع.
 */
router.post(
  '/payment-requests/:id/reject',
  auth,
  adminOnly,
  async (req, res, next) => {
    try {
      const requestId = Number(
        req.params.id
      );

      if (
        !Number.isInteger(
          requestId
        ) ||
        requestId <= 0
      ) {
        return res
          .status(400)
          .json({
            message:
              'Invalid payment request id',
          });
      }

      const paymentRequest =
        await prisma.paymentRequest
          .findUnique({
            where: {
              id: requestId,
            },
          });

      if (!paymentRequest) {
        return res
          .status(404)
          .json({
            message:
              'Payment request not found',
          });
      }

      if (
        paymentRequest.status ===
        'APPROVED'
      ) {
        return res
          .status(409)
          .json({
            message:
              'Approved payment requests cannot be rejected',
          });
      }

      if (
        paymentRequest.status ===
        'REJECTED'
      ) {
        return res.json({
          ok: true,
          alreadyRejected:
            true,
          paymentRequest,
        });
      }

      const rejected =
        await prisma.$transaction(
          async (tx) => {
            const updated =
              await tx.paymentRequest
                .update({
                  where: {
                    id:
                      requestId,
                  },
                  data: {
                    status:
                      'REJECTED',
                    decidedAt:
                      new Date(),
                  },
                });

            await tx.adminNotification
              .deleteMany({
                where: {
                  type:
                    'subscription',
                  sourceId:
                    requestId,
                },
              });

            return updated;
          }
        );

      return res.json({
        ok: true,
        alreadyRejected:
          false,
        paymentRequest:
          rejected,
      });
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * حالة اشتراك المستخدم الحالي.
 */
router.get(
  '/me',
  auth,
  async (req, res, next) => {
    try {
      const user =
        await prisma.user
          .findUnique({
            where: {
              id: req.user.id,
            },
          });

      if (!user) {
        return res
          .status(404)
          .json({
            message:
              'User not found',
          });
      }

      if (!user.isActive) {
        return res
          .status(403)
          .json({
            message:
              'Account suspended',
          });
      }

      const access =
        await getAccessState(
          user
        );

      return res.json(access);
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * سجل اشتراكات المستخدم.
 */
router.get(
  '/history',
  auth,
  async (req, res, next) => {
    try {
      await expireStaleSubscriptions(
        req.user.id
      );

      const subscriptions =
        await prisma.subscription
          .findMany({
            where: {
              userId:
                req.user.id,
            },
            orderBy: {
              createdAt:
                'desc',
            },
            include: {
              paymentRequest: {
                select: {
                  id: true,
                  packageName:
                    true,
                  price: true,
                  status: true,
                  createdAt:
                    true,
                  decidedAt:
                    true,
                },
              },
            },
          });

      return res.json(
        subscriptions
      );
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * جميع الاشتراكات للأدمن.
 */
router.get(
  '/admin/all',
  auth,
  adminOnly,
  async (req, res, next) => {
    try {
      await expireStaleSubscriptions(
        null
      );

      const subscriptions =
        await prisma.subscription
          .findMany({
            orderBy: {
              createdAt:
                'desc',
            },
            include: {
              user: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                  isActive: true,
                },
              },
              paymentRequest:
                true,
            },
          });

      return res.json(
        subscriptions
      );
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * إلغاء اشتراك من الأدمن.
 */
router.post(
  '/:id/cancel',
  auth,
  adminOnly,
  async (req, res, next) => {
    try {
      const subscriptionId =
        Number(req.params.id);

      if (
        !Number.isInteger(
          subscriptionId
        ) ||
        subscriptionId <= 0
      ) {
        return res
          .status(400)
          .json({
            message:
              'Invalid subscription id',
          });
      }

      const subscription =
        await prisma.subscription
          .findUnique({
            where: {
              id:
                subscriptionId,
            },
          });

      if (!subscription) {
        return res
          .status(404)
          .json({
            message:
              'Subscription not found',
          });
      }

      const cancelled =
        await prisma.subscription
          .update({
            where: {
              id:
                subscriptionId,
            },
            data: {
              status:
                CANCELLED,
            },
          });

      return res.json({
        ok: true,
        subscription:
          cancelled,
      });
    } catch (error) {
      return next(error);
    }
  }
);

module.exports = router;
module.exports.getAccessState =
  getAccessState;
module.exports.expireStaleSubscriptions =
  expireStaleSubscriptions;