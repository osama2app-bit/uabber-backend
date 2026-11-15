// الأخصائيون/الأطباء: التقديم من الحساب، موافقة الأدمن، الاشتراك، والظهور للمرضى.
const express = require('express');
const multer = require('multer');
const prisma = require('../config/prisma');
const { auth, adminOnly } = require('../middleware/auth');
const { uploadToCloudinary } = require('../utils/upload');

const router = express.Router();

const SPECIALTIES = {
  behavior: 'أخصائي/ة تعديل سلوك',
  speech: 'أخصائي/ة نطق',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
}).any();
const fileFor = (req, name) => (req.files || []).find((f) => f.fieldname === name);
const clean = (v, max) => (v === undefined || v === null ? undefined : String(v).trim().slice(0, max));

function isSubscriptionActive(profile) {
  return Boolean(profile?.subscriptionExpiry && profile.subscriptionExpiry > new Date());
}

/** هل يظهر الأخصائي للمرضى ويستقبل الحجوزات؟ */
function isBookable(profile) {
  return Boolean(
    profile && profile.status === 'APPROVED' && profile.isVisible && isSubscriptionActive(profile)
  );
}

function publicProfile(p, extra = {}) {
  return {
    id: p.id,
    displayName: p.displayName,
    specialty: p.specialty,
    specialtyLabel: SPECIALTIES[p.specialty] || p.specialty,
    title: p.title,
    bio: p.bio,
    photoUrl: p.photoUrl,
    sessionPriceJod: p.sessionPriceJod,
    sessionMinutes: p.sessionMinutes,
    ...extra,
  };
}

function ownProfile(p) {
  return {
    ...publicProfile(p),
    phone: p.phone,
    licenseUrl: p.licenseUrl,
    status: p.status,
    rejectionReason: p.rejectionReason,
    subscriptionExpiry: p.subscriptionExpiry,
    subscriptionActive: isSubscriptionActive(p),
    isVisible: p.isVisible,
    bookable: isBookable(p),
    createdAt: p.createdAt,
  };
}

router.use(auth);

// قائمة الأخصائيين المتاحين للمرضى (موافق عليهم + اشتراك فعّال)
router.get('/', async (req, res, next) => {
  try {
    const specialty = SPECIALTIES[req.query.specialty] ? req.query.specialty : undefined;
    const now = new Date();
    const rows = await prisma.specialistProfile.findMany({
      where: {
        status: 'APPROVED',
        isVisible: true,
        subscriptionExpiry: { gt: now },
        ...(specialty ? { specialty } : {}),
      },
      orderBy: { displayName: 'asc' },
      include: {
        _count: { select: { slots: { where: { isAvailable: true, startAt: { gt: now } } } } },
      },
    });
    res.json(rows.map((p) => publicProfile(p, { availableSlots: p._count.slots })));
  } catch (error) {
    next(error);
  }
});

// ملف الأخصائي الخاص بالمستخدم الحالي (أو null)
router.get('/me', async (req, res, next) => {
  try {
    const p = await prisma.specialistProfile.findUnique({ where: { userId: req.user.id } });
    res.json(p ? ownProfile(p) : null);
  } catch (error) {
    next(error);
  }
});

// تقديم طلب أخصائي أو تعديله (يعود الطلب للمراجعة إذا كان مرفوضًا)
router.post('/apply', upload, async (req, res, next) => {
  try {
    const displayName = clean(req.body.displayName, 80);
    const specialty = clean(req.body.specialty, 20);
    if (!displayName || displayName.length < 3) {
      return res.status(400).json({ message: 'اكتب الاسم الذي يظهر للمرضى' });
    }
    if (!SPECIALTIES[specialty]) {
      return res.status(400).json({ message: 'اختر التخصص' });
    }

    const existing = await prisma.specialistProfile.findUnique({ where: { userId: req.user.id } });
    if (existing?.status === 'SUSPENDED') {
      return res.status(403).json({ message: 'تم إيقاف حساب الأخصائي، تواصل مع الإدارة' });
    }

    const photo = fileFor(req, 'photo');
    const license = fileFor(req, 'license');
    const data = {
      displayName,
      specialty,
      title: clean(req.body.title, 120) || null,
      bio: clean(req.body.bio, 1000) || null,
      phone: clean(req.body.phone, 30) || null,
    };
    if (photo) data.photoUrl = await uploadToCloudinary(photo, 'specialists/photos');
    if (license) data.licenseUrl = await uploadToCloudinary(license, 'specialists/licenses');

    if (!existing && !data.licenseUrl) {
      return res.status(400).json({ message: 'أرفق صورة شهادة/ترخيص مزاولة المهنة' });
    }

    let profile;
    if (existing) {
      // تغيير الاسم أو التخصص أو الشهادة يحتاج مراجعة جديدة
      const needsReview =
        existing.status === 'REJECTED' ||
        existing.specialty !== specialty ||
        Boolean(license);
      profile = await prisma.specialistProfile.update({
        where: { id: existing.id },
        data: {
          ...data,
          ...(needsReview ? { status: 'PENDING', rejectionReason: null } : {}),
        },
      });
    } else {
      profile = await prisma.specialistProfile.create({
        data: { ...data, userId: req.user.id },
      });
    }

    if (profile.status === 'PENDING') {
      await prisma.adminNotification.upsert({
        where: { type_sourceId: { type: 'specialist', sourceId: profile.id } },
        update: { isRead: false, title: 'طلب أخصائي جديد', body: `${profile.displayName} - ${SPECIALTIES[profile.specialty]}` },
        create: {
          title: 'طلب أخصائي جديد',
          body: `${profile.displayName} - ${SPECIALTIES[profile.specialty]}`,
          type: 'specialist',
          sourceId: profile.id,
          route: '/admin/specialists',
        },
      });
    }

    res.json(ownProfile(profile));
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// الأدمن
// ---------------------------------------------------------------------------
router.get('/admin/all', adminOnly, async (_req, res, next) => {
  try {
    const now = new Date();
    const rows = await prisma.specialistProfile.findMany({
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        user: { select: { email: true, fullName: true } },
        _count: {
          select: {
            consultations: true,
            slots: { where: { startAt: { gt: now } } },
          },
        },
      },
    });
    res.json(
      rows.map((p) => ({
        ...ownProfile(p),
        email: p.user.email,
        accountName: p.user.fullName,
        consultationsCount: p._count.consultations,
        upcomingSlots: p._count.slots,
      }))
    );
  } catch (error) {
    next(error);
  }
});

// موافقة/رفض/إيقاف، السعر والمدة، تمديد الاشتراك يدويًا، الإظهار
router.put('/admin/:id', adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const profile = await prisma.specialistProfile.findUnique({ where: { id } });
    if (!profile) return res.status(404).json({ message: 'الأخصائي غير موجود' });

    const data = {};
    if (req.body.status !== undefined) {
      const status = String(req.body.status).toUpperCase();
      if (!['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'].includes(status)) {
        return res.status(400).json({ message: 'حالة غير صالحة' });
      }
      if (status === 'REJECTED' && !clean(req.body.rejectionReason, 300)) {
        return res.status(400).json({ message: 'اكتب سبب الرفض' });
      }
      data.status = status;
      data.rejectionReason = status === 'REJECTED' ? clean(req.body.rejectionReason, 300) : null;
    }
    if (req.body.sessionPriceJod !== undefined) {
      const v = Number.parseInt(req.body.sessionPriceJod, 10);
      if (!Number.isInteger(v) || v < 0 || v > 1000) return res.status(400).json({ message: 'سعر الجلسة غير صالح' });
      data.sessionPriceJod = v;
    }
    if (req.body.sessionMinutes !== undefined) {
      const v = Number.parseInt(req.body.sessionMinutes, 10);
      if (![30, 45, 60, 90].includes(v)) return res.status(400).json({ message: 'مدة الجلسة: 30 أو 45 أو 60 أو 90 دقيقة' });
      data.sessionMinutes = v;
    }
    if (req.body.isVisible !== undefined) data.isVisible = req.body.isVisible === true || req.body.isVisible === 'true';
    if (req.body.subscriptionExpiry !== undefined) {
      const d = req.body.subscriptionExpiry ? new Date(req.body.subscriptionExpiry) : null;
      if (d && Number.isNaN(d.getTime())) return res.status(400).json({ message: 'تاريخ غير صالح' });
      data.subscriptionExpiry = d;
    }
    if (req.body.extendDays !== undefined) {
      const days = Number.parseInt(req.body.extendDays, 10);
      if (!Number.isInteger(days) || days < 1 || days > 3660) return res.status(400).json({ message: 'عدد الأيام غير صالح' });
      const base = isSubscriptionActive(profile) ? profile.subscriptionExpiry : new Date();
      data.subscriptionExpiry = new Date(base.getTime() + days * 86400000);
    }

    const updated = await prisma.specialistProfile.update({ where: { id }, data });
    if (data.status && data.status !== 'PENDING') {
      await prisma.adminNotification.deleteMany({ where: { type: 'specialist', sourceId: id } });
    }
    res.json(ownProfile(updated));
  } catch (error) {
    next(error);
  }
});

module.exports = { router, SPECIALTIES, isBookable, isSubscriptionActive };
