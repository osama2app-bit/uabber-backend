// جداول الدوام الأسبوعية للأخصائيين.
//   الأخصائي: GET/PUT /api/schedules/mine, POST /api/schedules/mine/generate
//   الأدمن:   GET /api/schedules, GET/PUT /api/schedules/:profileId,
//             POST /api/schedules/:profileId/generate
const express = require('express');
const prisma = require('../config/prisma');
const { auth, adminOnly } = require('../middleware/auth');
const { validateSchedule, syncScheduleSlots, presentSchedule } = require('../services/schedule');

const router = express.Router();

const toInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** ملخص المواعيد المستقبلية حسب الحالة. */
async function slotStats(profileId) {
  const rows = await prisma.specialistAvailability.groupBy({
    by: ['status'],
    where: { specialistProfileId: profileId, startAt: { gt: new Date() } },
    _count: { _all: true },
  });
  const stats = { AVAILABLE: 0, BOOKED: 0, COMPLETED: 0, CANCELLED: 0, UNAVAILABLE: 0 };
  for (const r of rows) stats[r.status] = r._count._all;
  return stats;
}

async function present(profile) {
  const schedule = await prisma.specialistSchedule.findUnique({
    where: { specialistProfileId: profile.id },
  });
  return {
    specialistProfileId: profile.id,
    displayName: profile.displayName,
    specialty: profile.specialty,
    status: profile.status,
    subscriptionExpiry: profile.subscriptionExpiry,
    schedule: presentSchedule(schedule),
    upcoming: await slotStats(profile.id),
  };
}

/** حفظ الجدول ثم إعادة توليد المواعيد المستقبلية غير المحجوزة. */
async function saveSchedule(profile, body) {
  const { schedule, error } = validateSchedule(body);
  if (error) return { error };
  const data = {
    weekdays: schedule.weekdays,
    startMinutes: schedule.startMinutes,
    endMinutes: schedule.endMinutes,
    sessionMinutes: schedule.sessionMinutes,
    breakMinutes: schedule.breakMinutes,
    maxSessionsPerDay: schedule.maxSessionsPerDay,
    timeZone: schedule.timeZone,
    validFrom: schedule.validFrom,
    validUntil: schedule.validUntil,
    isActive: schedule.isActive,
  };
  await prisma.specialistSchedule.upsert({
    where: { specialistProfileId: profile.id },
    create: { specialistProfileId: profile.id, ...data },
    update: data,
  });
  // مدة الجلسة المعروضة للأهالي تتبع الجدول
  if (profile.sessionMinutes !== schedule.sessionMinutes) {
    await prisma.specialistProfile.update({
      where: { id: profile.id },
      data: { sessionMinutes: schedule.sessionMinutes },
    });
  }
  // الحجوزات المؤكدة لا تُحذف ولا تتغير: نستبدل فقط المواعيد المتاحة غير المحجوزة
  const sync = await syncScheduleSlots(prisma, profile.id, { replaceFuture: true });
  return { sync };
}

// ---------------------------------------------------------------------------
// الأخصائي
// ---------------------------------------------------------------------------

async function myProfile(req, res) {
  const profile = await prisma.specialistProfile.findUnique({ where: { userId: req.user.id } });
  if (!profile) {
    res.status(404).json({ message: 'لا يوجد حساب أخصائي' });
    return null;
  }
  return profile;
}

router.get('/mine', auth, async (req, res, next) => {
  try {
    const profile = await myProfile(req, res);
    if (!profile) return undefined;
    return res.json(await present(profile));
  } catch (error) {
    return next(error);
  }
});

router.put('/mine', auth, async (req, res, next) => {
  try {
    const profile = await myProfile(req, res);
    if (!profile) return undefined;
    if (profile.status !== 'APPROVED') {
      return res.status(403).json({ message: 'حساب الأخصائي غير مفعّل بعد' });
    }
    const result = await saveSchedule(profile, req.body);
    if (result.error) return res.status(400).json({ message: result.error });
    return res.json({ ...(await present(profile)), ...result.sync });
  } catch (error) {
    return next(error);
  }
});

router.post('/mine/generate', auth, async (req, res, next) => {
  try {
    const profile = await myProfile(req, res);
    if (!profile) return undefined;
    const sync = await syncScheduleSlots(prisma, profile.id);
    return res.json({ ...(await present(profile)), ...sync });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// الأدمن
// ---------------------------------------------------------------------------

router.get('/', auth, adminOnly, async (_req, res, next) => {
  try {
    const profiles = await prisma.specialistProfile.findMany({
      where: { status: { in: ['APPROVED', 'SUSPENDED'] } },
      orderBy: { displayName: 'asc' },
    });
    const rows = [];
    for (const profile of profiles) rows.push(await present(profile));
    return res.json(rows);
  } catch (error) {
    return next(error);
  }
});

async function adminProfile(req, res) {
  const id = toInt(req.params.profileId);
  const profile = id ? await prisma.specialistProfile.findUnique({ where: { id } }) : null;
  if (!profile) {
    res.status(404).json({ message: 'الأخصائي غير موجود' });
    return null;
  }
  return profile;
}

router.get('/:profileId', auth, adminOnly, async (req, res, next) => {
  try {
    const profile = await adminProfile(req, res);
    if (!profile) return undefined;
    return res.json(await present(profile));
  } catch (error) {
    return next(error);
  }
});

router.put('/:profileId', auth, adminOnly, async (req, res, next) => {
  try {
    const profile = await adminProfile(req, res);
    if (!profile) return undefined;
    const result = await saveSchedule(profile, req.body);
    if (result.error) return res.status(400).json({ message: result.error });
    return res.json({ ...(await present(profile)), ...result.sync });
  } catch (error) {
    return next(error);
  }
});

router.post('/:profileId/generate', auth, adminOnly, async (req, res, next) => {
  try {
    const profile = await adminProfile(req, res);
    if (!profile) return undefined;
    const sync = await syncScheduleSlots(prisma, profile.id);
    return res.json({ ...(await present(profile)), ...sync });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
