const express = require('express');
const prisma = require('../config/prisma');
const { auth, adminOnly } = require('../middleware/auth');
const { makeUpload, fileUrl } = require('../utils/upload');
const { SPECIALTIES, isBookable } = require('./specialists.routes');
const { normalizeMeetUrl, whatsappPhone, formatSessionDate, buildMeetingMessage } = require('../utils/meetingLink');
const whatsapp = require('../services/whatsapp');
const { checkAgainstSchedule } = require('../services/schedule');

const router = express.Router();

const BEHAVIOR_SPECIALIST = SPECIALTIES.behavior;
const SPEECH_SPECIALIST = SPECIALTIES.speech;
// استشارات النطق مفعّلة الآن
const ALLOWED_SPECIALISTS = new Set([BEHAVIOR_SPECIALIST, SPEECH_SPECIALIST]);
const SESSION_DURATION_MINUTES = 45;
const SESSION_PRICE_JOD = 10;

const allowedStatuses = new Set([
  'NEW',
  'PAYMENT_CONFIRMED',
  'ACCEPTED',
  'REJECTED',
  'CHANGED',
  'COMPLETED',
  'CANCELLED',
]);
const reusableStatuses = new Set(['REJECTED', 'CANCELLED']);

function asPositiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function validPhone(value) {
  return /^\+?[0-9\s-]{8,20}$/.test(value);
}

function parseDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

function parseTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return { hour, minute, totalMinutes: hour * 60 + minute };
}

function addCalendarDay(dateParts, numberOfDays) {
  const date = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day + numberOfDays));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function compareCalendarDates(a, b) {
  const aValue = Date.UTC(a.year, a.month - 1, a.day);
  const bValue = Date.UTC(b.year, b.month - 1, b.day);
  return aValue - bValue;
}

function localWeekday(dateParts) {
  return new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day)).getUTCDay();
}

function localDateTimeToUtc(dateParts, minutesFromMidnight, utcOffsetMinutes) {
  const hour = Math.floor(minutesFromMidnight / 60);
  const minute = minutesFromMidnight % 60;

  return new Date(
    Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, hour, minute) -
      utcOffsetMinutes * 60 * 1000,
  );
}


const ACTIVE_STATUSES = ['NEW', 'PAYMENT_CONFIRMED', 'ACCEPTED', 'CHANGED'];

const profileSummary = {
  select: {
    id: true, displayName: true, specialty: true, title: true,
    photoUrl: true, sessionPriceJod: true, sessionMinutes: true,
  },
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}

/** من ينفّذ الطلب: أدمن، أو أخصائي (مع ملفه)، أو مستخدم عادي. */
async function actorOf(req) {
  const isAdmin = req.user.role === 'ADMIN';
  const profile = await prisma.specialistProfile.findUnique({ where: { userId: req.user.id } });
  return { isAdmin, profile };
}

/** مالك الموعد/الحجز = الأدمن، أو الأخصائي صاحب الملف. */
function canManage(actor, specialistProfileId) {
  if (actor.isAdmin) return true;
  return Boolean(actor.profile && specialistProfileId && actor.profile.id === specialistProfileId);
}

// يمنع تداخل مواعيد نفس الأخصائي (أو نفس التخصص للمواعيد القديمة بدون أخصائي).
function ownerWhere(owner) {
  return owner.profileId
    ? { specialistProfileId: owner.profileId }
    : { specialistProfileId: null, specialist: owner.specialist };
}

async function findOverlap(db, owner, startAt, durationMinutes, excludeId) {
  const ms = durationMinutes * 60 * 1000;
  return db.specialistAvailability.findFirst({
    where: {
      ...ownerWhere(owner),
      ...(excludeId ? { id: { not: excludeId } } : {}),
      startAt: {
        gt: new Date(startAt.getTime() - ms),
        lt: new Date(startAt.getTime() + ms),
      },
    },
  });
}

function overlapsAny(startAt, existingStarts, durationMinutes) {
  const ms = durationMinutes * 60 * 1000;
  return existingStarts.some((t) => Math.abs(t - startAt.getTime()) < ms);
}

function sendError(res, next, error) {
  if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
  return next(error);
}

// الاجتماعات: لا يوجد أي إنشاء تلقائي. الأخصائي ينشئ اجتماع Google Meet بنفسه،
// يلصق الرابط، ويرسله للمريض عبر واتساب (انظر مسارات /:id/meeting أدناه).
const MEETING_STATUSES = new Set(['ACCEPTED', 'CHANGED', 'PAYMENT_CONFIRMED']);
// منع الإرسال المكرر: محاولة واحدة كل 10 ثوانٍ لنفس الحجز
const SEND_COOLDOWN_MS = Number(process.env.MEETING_SEND_COOLDOWN_MS || 10 * 1000);
const AUTO_MEET_DISABLED =
  'الإنشاء التلقائي للاجتماعات متوقف. أنشئ الاجتماع من Google Meet والصق الرابط ثم أرسله للمريض عبر واتساب.';

// لتوافق نسخ التطبيق القديمة
router.get('/meeting-config', auth, (_req, res) => {
  res.json({ autoMeet: false, whatsappApi: whatsapp.isWhatsAppApiConfigured() });
});

router.post('/meeting-test', auth, adminOnly, (_req, res) => {
  res.status(410).json({ ok: false, message: AUTO_MEET_DISABLED });
});

// ---------------------------------------------------------------------------
// المواعيد
// ---------------------------------------------------------------------------

// للمرضى: مواعيد الأخصائيين المتاحين (+ المواعيد القديمة التي أضافها الأدمن)
router.get('/availability', auth, async (req, res, next) => {
  try {
    const now = new Date();
    const specialistProfileId = asPositiveInt(req.query.specialistProfileId);
    const requestedSpecialist = String(req.query.specialist || '').trim();

    const slots = await prisma.specialistAvailability.findMany({
      where: {
        isAvailable: true,
        status: 'AVAILABLE',
        startAt: { gt: now },
        ...(requestedSpecialist ? { specialist: requestedSpecialist } : {}),
        ...(specialistProfileId
          ? { specialistProfileId }
          : {
              OR: [
                { specialistProfileId: null },
                {
                  specialistProfile: {
                    status: 'APPROVED',
                    isVisible: true,
                    subscriptionExpiry: { gt: now },
                  },
                },
              ],
            }),
      },
      orderBy: { startAt: 'asc' },
      include: { specialistProfile: profileSummary },
    });

    // أخصائي اشتراكه منتهٍ أو موقوف لا تظهر مواعيده
    const visible = specialistProfileId
      ? (await prisma.specialistProfile.findUnique({ where: { id: specialistProfileId } }).then((p) => (isBookable(p) ? slots : [])))
      : slots;
    return res.json(visible);
  } catch (error) {
    return next(error);
  }
});

router.get('/availability/admin', auth, adminOnly, async (_req, res, next) => {
  try {
    const slots = await prisma.specialistAvailability.findMany({
      orderBy: { startAt: 'desc' },
      include: {
        specialistProfile: profileSummary,
        consultations: {
          where: { status: { notIn: ['REJECTED', 'CANCELLED'] } },
          select: { id: true, status: true, userName: true },
        },
      },
    });
    return res.json(slots);
  } catch (error) {
    return next(error);
  }
});

// مواعيد الأخصائي نفسه
router.get('/availability/mine', auth, async (req, res, next) => {
  try {
    const { profile } = await actorOf(req);
    if (!profile) return res.json([]);
    const slots = await prisma.specialistAvailability.findMany({
      where: { specialistProfileId: profile.id },
      orderBy: { startAt: 'desc' },
      include: {
        consultations: {
          where: { status: { notIn: ['REJECTED', 'CANCELLED'] } },
          select: { id: true, status: true, userName: true },
        },
      },
    });
    return res.json(slots);
  } catch (error) {
    return next(error);
  }
});

// إنشاء موعد منفرد أو جدول مواعيد (الأدمن أو الأخصائي لنفسه)
router.post('/availability', auth, async (req, res, next) => {
  try {
    const actor = await actorOf(req);
    let owner;
    let durationMinutes = SESSION_DURATION_MINUTES;

    if (actor.isAdmin && req.body.specialistProfileId) {
      const p = await prisma.specialistProfile.findUnique({
        where: { id: asPositiveInt(req.body.specialistProfileId) || 0 },
      });
      if (!p) return res.status(404).json({ message: 'الأخصائي غير موجود' });
      owner = { profileId: p.id, specialist: SPECIALTIES[p.specialty] };
      durationMinutes = p.sessionMinutes;
    } else if (actor.isAdmin) {
      const specialist = String(req.body.specialist || '').trim();
      if (!ALLOWED_SPECIALISTS.has(specialist)) {
        return res.status(400).json({ message: 'نوع الاستشارة غير صالح' });
      }
      owner = { profileId: null, specialist };
    } else {
      const p = actor.profile;
      if (!p || p.status !== 'APPROVED') {
        return res.status(403).json({ message: 'حساب الأخصائي غير مفعّل بعد' });
      }
      if (!isBookable(p)) {
        return res.status(403).json({ message: 'اشتراك الأخصائي منتهٍ، جدّد الاشتراك لإضافة مواعيد' });
      }
      owner = { profileId: p.id, specialist: SPECIALTIES[p.specialty] };
      durationMinutes = p.sessionMinutes;
    }

    const isBulkRequest = Array.isArray(req.body.weekdays);

    if (!isBulkRequest) {
      const startAt = new Date(req.body.startAt);
      if (Number.isNaN(startAt.getTime()) || startAt <= new Date()) {
        return res.status(400).json({ message: 'يجب اختيار موعد مستقبلي صالح' });
      }
      const overlap = await findOverlap(prisma, owner, startAt, durationMinutes);
      if (overlap) {
        return res.status(409).json({ message: 'يوجد موعد آخر متداخل مع هذا الوقت' });
      }
      // إن كان للأخصائي جدول دوام: الموعد اليدوي يلتزم بساعات الدوام والحد اليومي
      if (owner.profileId) {
        const problem = await checkAgainstSchedule(prisma, owner.profileId, startAt, durationMinutes);
        if (problem) return res.status(400).json({ message: problem });
      }
      const slot = await prisma.specialistAvailability.create({
        data: {
          specialist: owner.specialist,
          specialistProfileId: owner.profileId,
          startAt,
          durationMinutes,
          isAvailable: req.body.isAvailable !== false,
          status: req.body.isAvailable === false ? 'UNAVAILABLE' : 'AVAILABLE',
        },
      });
      return res.status(201).json(slot);
    }

    const startDate = parseDateOnly(req.body.startDate);
    const endDate = parseDateOnly(req.body.endDate);
    const startTime = parseTime(req.body.startTime);
    const endTime = parseTime(req.body.endTime);
    const maxSessionsPerDay = asPositiveInt(req.body.maxSessionsPerDay);
    const utcOffsetMinutes = Number(req.body.utcOffsetMinutes ?? 0);
    const weekdays = [...new Set(req.body.weekdays.map(Number))];

    if (!startDate || !endDate || compareCalendarDates(startDate, endDate) > 0) {
      return res.status(400).json({ message: 'فترة التواريخ غير صالحة' });
    }
    if (!startTime || !endTime || endTime.totalMinutes <= startTime.totalMinutes) {
      return res.status(400).json({ message: 'وقت بداية أو نهاية الدوام غير صالح' });
    }
    if (!maxSessionsPerDay || maxSessionsPerDay > 30) {
      return res.status(400).json({ message: 'عدد الجلسات اليومي يجب أن يكون بين 1 و30' });
    }
    if (!Number.isFinite(utcOffsetMinutes) || Math.abs(utcOffsetMinutes) > 14 * 60) {
      return res.status(400).json({ message: 'المنطقة الزمنية غير صالحة' });
    }
    if (weekdays.length === 0 || weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      return res.status(400).json({ message: 'يجب اختيار يوم واحد على الأقل' });
    }

    const starts = [];
    let currentDate = startDate;
    while (compareCalendarDates(currentDate, endDate) <= 0) {
      if (weekdays.includes(localWeekday(currentDate))) {
        let sessionsCreatedForDay = 0;
        let currentMinutes = startTime.totalMinutes;
        while (
          sessionsCreatedForDay < maxSessionsPerDay &&
          currentMinutes + durationMinutes <= endTime.totalMinutes
        ) {
          const startAt = localDateTimeToUtc(currentDate, currentMinutes, utcOffsetMinutes);
          if (startAt > new Date()) starts.push(startAt);
          currentMinutes += durationMinutes;
          sessionsCreatedForDay += 1;
        }
      }
      currentDate = addCalendarDay(currentDate, 1);
    }

    if (starts.length === 0) {
      return res.status(400).json({
        message: 'لم يتم إنشاء مواعيد؛ تأكد من الأيام والفترة والساعات المختارة',
      });
    }
    if (starts.length > 500) {
      return res.status(400).json({ message: 'عدد المواعيد كبير جدًا، اختر فترة أقصر' });
    }

    const rangeMs = durationMinutes * 60 * 1000;
    const existing = await prisma.specialistAvailability.findMany({
      where: {
        ...ownerWhere(owner),
        startAt: {
          gt: new Date(starts[0].getTime() - rangeMs),
          lt: new Date(starts[starts.length - 1].getTime() + rangeMs),
        },
      },
      select: { startAt: true },
    });
    const existingStarts = existing.map((e) => e.startAt.getTime());
    const freeStarts = starts.filter((startAt) => !overlapsAny(startAt, existingStarts, durationMinutes));
    if (freeStarts.length === 0) {
      return res.status(409).json({
        message: 'كل هذه المواعيد موجودة مسبقًا أو متداخلة مع مواعيد أخرى',
      });
    }

    const result = await prisma.specialistAvailability.createMany({
      data: freeStarts.map((startAt) => ({
        specialist: owner.specialist,
        specialistProfileId: owner.profileId,
        startAt,
        durationMinutes,
        isAvailable: true,
      })),
      skipDuplicates: true,
    });

    return res.status(201).json({
      createdCount: result.count,
      requestedCount: starts.length,
      skippedCount: starts.length - result.count,
      durationMinutes,
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ message: 'هذا الموعد مضاف مسبقًا' });
    }
    return next(error);
  }
});

router.put('/availability/:id', auth, async (req, res, next) => {
  try {
    const id = asPositiveInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'رقم الموعد غير صالح' });

    const current = await prisma.specialistAvailability.findUnique({ where: { id } });
    if (!current) return res.status(404).json({ message: 'الموعد غير موجود' });
    const actor = await actorOf(req);
    if (!canManage(actor, current.specialistProfileId)) {
      return res.status(403).json({ message: 'لا تملك صلاحية تعديل هذا الموعد' });
    }

    const data = {};
    if (req.body.startAt !== undefined) {
      const startAt = new Date(req.body.startAt);
      if (Number.isNaN(startAt.getTime()) || startAt <= new Date()) {
        return res.status(400).json({ message: 'الموعد غير صالح' });
      }
      const overlap = await findOverlap(
        prisma,
        { profileId: current.specialistProfileId, specialist: current.specialist },
        startAt,
        current.durationMinutes,
        id
      );
      if (overlap) {
        return res.status(409).json({ message: 'يوجد موعد آخر متداخل مع هذا الوقت' });
      }
      data.startAt = startAt;
    }
    // الحالة: متاح / غير متاح / ملغى — فقط لموعد غير محجوز
    let nextStatus = null;
    if (req.body.status !== undefined) {
      nextStatus = String(req.body.status).toUpperCase();
      if (!['AVAILABLE', 'UNAVAILABLE', 'CANCELLED'].includes(nextStatus)) {
        return res.status(400).json({ message: 'حالة الموعد غير صالحة' });
      }
    } else if (req.body.isAvailable !== undefined) {
      nextStatus = req.body.isAvailable ? 'AVAILABLE' : 'UNAVAILABLE';
    }
    if (nextStatus) {
      if (['BOOKED', 'COMPLETED'].includes(current.status)) {
        return res.status(409).json({ message: 'لا يمكن تغيير حالة موعد محجوز أو مكتمل' });
      }
      if (nextStatus === 'AVAILABLE' && current.startAt <= new Date()) {
        return res.status(400).json({ message: 'لا يمكن إتاحة موعد في الماضي' });
      }
      data.status = nextStatus;
      data.isAvailable = nextStatus === 'AVAILABLE';
    }

    const slot = await prisma.specialistAvailability.update({ where: { id }, data });
    return res.json(slot);
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ message: 'هذا الموعد مضاف مسبقًا' });
    }
    return next(error);
  }
});

router.delete('/availability/:id', auth, async (req, res, next) => {
  try {
    const id = asPositiveInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'رقم الموعد غير صالح' });

    const slot = await prisma.specialistAvailability.findUnique({ where: { id } });
    if (!slot) return res.status(404).json({ message: 'الموعد غير موجود' });
    const actor = await actorOf(req);
    if (!canManage(actor, slot.specialistProfileId)) {
      return res.status(403).json({ message: 'لا تملك صلاحية حذف هذا الموعد' });
    }

    const activeBooking = await prisma.consultation.findFirst({
      where: { availabilityId: id, status: { notIn: ['REJECTED', 'CANCELLED'] } },
    });
    if (activeBooking) {
      return res.status(409).json({ message: 'لا يمكن حذف موعد مرتبط بطلب فعال' });
    }

    await prisma.consultation.updateMany({ where: { availabilityId: id }, data: { availabilityId: null } });
    await prisma.specialistAvailability.delete({ where: { id } });
    return res.status(204).send();
  } catch (error) {
    return next(error);
  }
});

// حذف عدة مواعيد فارغة دفعة واحدة (المحجوزة لا تُحذف)
router.post('/availability/bulk-delete', auth, async (req, res, next) => {
  try {
    const actor = await actorOf(req);
    let ids = (Array.isArray(req.body.ids) ? req.body.ids : [])
      .map(asPositiveInt)
      .filter(Boolean)
      .slice(0, 500);
    if (!ids.length) return res.status(400).json({ message: 'لم يتم اختيار مواعيد' });

    if (!actor.isAdmin) {
      if (!actor.profile) return res.status(403).json({ message: 'غير مسموح' });
      const own = await prisma.specialistAvailability.findMany({
        where: { id: { in: ids }, specialistProfileId: actor.profile.id },
        select: { id: true },
      });
      ids = own.map((o) => o.id);
    }

    const booked = await prisma.consultation.findMany({
      where: { availabilityId: { in: ids }, status: { notIn: ['REJECTED', 'CANCELLED'] } },
      select: { availabilityId: true },
    });
    const bookedIds = new Set(booked.map((b) => b.availabilityId));
    const deletable = ids.filter((id) => !bookedIds.has(id));

    await prisma.consultation.updateMany({
      where: { availabilityId: { in: deletable } },
      data: { availabilityId: null },
    });
    const result = await prisma.specialistAvailability.deleteMany({ where: { id: { in: deletable } } });
    return res.json({ deletedCount: result.count, skippedBooked: bookedIds.size });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// الحجوزات
// ---------------------------------------------------------------------------

const consultationInclude = {
  availability: true,
  specialistProfile: profileSummary,
};

// طلبات المريض وحالتها (مع رابط الاجتماع)
router.get('/mine', auth, async (req, res, next) => {
  try {
    const rows = await prisma.consultation.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true, specialist: true, status: true, rejectionReason: true,
        date: true, durationMinutes: true, priceJod: true, createdAt: true,
        meetingUrl: true,
        specialistProfile: profileSummary,
      },
    });
    return res.json(rows);
  } catch (error) {
    return next(error);
  }
});

// حجوزات الأخصائي
router.get('/specialist', auth, async (req, res, next) => {
  try {
    const { profile } = await actorOf(req);
    if (!profile) return res.json([]);
    const rows = await prisma.consultation.findMany({
      where: { specialistProfileId: profile.id },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      include: consultationInclude,
    });
    return res.json(rows);
  } catch (error) {
    return next(error);
  }
});

router.post('/', auth, makeUpload('consultation-receipts', 'receipt'), async (req, res, next) => {
  try {
    const userName = String(req.body.userName || '').trim();
    const phone = String(req.body.phone || '').trim();
    const availabilityId = asPositiveInt(req.body.availabilityId);
    const message = String(req.body.message || '').trim();

    if (!userName || !phone || !availabilityId || !req.file) {
      return res.status(400).json({
        message: 'الاسم ورقم الهاتف والموعد وصورة وصل الدفع حقول إجبارية',
      });
    }
    if (!validPhone(phone)) {
      return res.status(400).json({ message: 'رقم الهاتف غير صالح' });
    }

    const receiptUrl = await fileUrl(req, 'consultation-receipts', req.file);

    const consultation = await prisma.$transaction(async (tx) => {
      const slot = await tx.specialistAvailability.findUnique({
        where: { id: availabilityId },
        include: { specialistProfile: true },
      });

      if (!slot || !slot.isAvailable || slot.status !== 'AVAILABLE' || slot.startAt <= new Date()) {
        throw new HttpError(409, 'عذرًا، هذا الموعد غير متاح. يرجى اختيار موعد مختلف.');
      }
      if (slot.specialistProfile && !isBookable(slot.specialistProfile)) {
        throw new HttpError(409, 'هذا الأخصائي لا يستقبل حجوزات حاليًا');
      }
      if (slot.specialistProfile && slot.specialistProfile.userId === req.user.id) {
        throw new HttpError(400, 'لا يمكنك حجز موعد عند نفسك');
      }

      const locked = await tx.specialistAvailability.updateMany({
        where: { id: availabilityId, isAvailable: true, status: 'AVAILABLE', startAt: { gt: new Date() } },
        data: { isAvailable: false, status: 'BOOKED' },
      });
      if (locked.count !== 1) {
        throw new HttpError(409, 'عذرًا، تم حجز هذا الموعد من عميل آخر. يرجى اختيار موعد مختلف.');
      }

      const price = slot.specialistProfile?.sessionPriceJod ?? SESSION_PRICE_JOD;
      const created = await tx.consultation.create({
        data: {
          userId: req.user.id,
          availabilityId: slot.id,
          specialistProfileId: slot.specialistProfileId,
          userName,
          userEmail: req.user.email,
          phone,
          specialist: slot.specialist,
          message: message || null,
          receiptUrl,
          durationMinutes: slot.durationMinutes,
          priceJod: price,
          date: slot.startAt,
          time: slot.startAt.toISOString().slice(11, 16),
        },
      });

      const who = slot.specialistProfile?.displayName || slot.specialist;
      await tx.adminNotification.create({
        data: {
          title: 'طلب استشارة جديد',
          body: `${userName} - ${who} - ${slot.durationMinutes} دقيقة`,
          type: 'consultation',
          sourceId: created.id,
          route: '/admin/consultations',
        },
      });

      return created;
    });

    return res.status(201).json(consultation);
  } catch (error) {
    return sendError(res, next, error);
  }
});

router.get('/', auth, adminOnly, async (_req, res, next) => {
  try {
    const consultations = await prisma.consultation.findMany({
      orderBy: { id: 'desc' },
      include: consultationInclude,
    });
    return res.json(consultations);
  } catch (error) {
    return next(error);
  }
});

async function loadManaged(req, id) {
  const consultation = await prisma.consultation.findUnique({ where: { id } });
  if (!consultation) throw new HttpError(404, 'طلب الاستشارة غير موجود');
  const actor = await actorOf(req);
  if (!canManage(actor, consultation.specialistProfileId)) {
    throw new HttpError(403, 'لا تملك صلاحية على هذا الطلب');
  }
  return { consultation, actor };
}

router.put('/:id/status', auth, async (req, res, next) => {
  try {
    const id = asPositiveInt(req.params.id);
    const status = String(req.body.status || '').toUpperCase();
    const rejectionReason = String(req.body.rejectionReason || '').trim();

    if (!id) return res.status(400).json({ message: 'رقم الطلب غير صالح' });
    if (!allowedStatuses.has(status)) {
      return res.status(400).json({ message: 'حالة الطلب غير صالحة' });
    }
    if (status === 'REJECTED' && !rejectionReason) {
      return res.status(400).json({ message: 'سبب الرفض مطلوب' });
    }

    const { actor } = await loadManaged(req, id);
    // تأكيد الدفع من صلاحية الإدارة فقط (الدفع يصل للإدارة)
    if (status === 'PAYMENT_CONFIRMED' && !actor.isAdmin) {
      return res.status(403).json({ message: 'تأكيد الدفع من صلاحية الإدارة' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.consultation.findUnique({ where: { id } });
      const consultation = await tx.consultation.update({
        where: { id },
        data: {
          status,
          rejectionReason: status === 'REJECTED' ? rejectionReason : null,
        },
      });

      if (reusableStatuses.has(status) && existing.availabilityId) {
        // إلغاء/رفض الحجز يعيد الموعد متاحًا لنفس التاريخ (إن كان مستقبليًا)
        const reopen = Boolean(existing.date && existing.date > new Date());
        await tx.specialistAvailability.updateMany({
          where: { id: existing.availabilityId, status: 'BOOKED' },
          data: { isAvailable: reopen, status: reopen ? 'AVAILABLE' : 'CANCELLED' },
        });
      }
      if (status === 'COMPLETED' && existing.availabilityId) {
        await tx.specialistAvailability.updateMany({
          where: { id: existing.availabilityId },
          data: { isAvailable: false, status: 'COMPLETED' },
        });
      }

      if (status !== 'NEW') {
        await tx.adminNotification.deleteMany({ where: { type: 'consultation', sourceId: id } });
      }
      return consultation;
    });

    // لا إنشاء/حذف اجتماعات تلقائيًا: رابط الاجتماع اليدوي يبقى كما هو.
    return res.json(await prisma.consultation.findUnique({ where: { id: updated.id }, include: consultationInclude }));
  } catch (error) {
    return sendError(res, next, error);
  }
});

// بيانات حالة إرسال الرابط تُعاد ضبطها عند تغيير الرابط أو الموعد
const RESET_SEND_STATE = {
  meetingLinkStatus: null,
  meetingLinkChannel: null,
  meetingLinkSentUrl: null,
  meetingLinkSentAt: null,
  meetingLinkError: null,
};

function readMeetUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return { url: null };
  const url = normalizeMeetUrl(raw);
  if (!url) {
    throw new HttpError(400, 'رابط Google Meet غير صالح (مثال: https://meet.google.com/abc-defg-hij)');
  }
  return { url };
}

const loadFull = (id) => prisma.consultation.findUnique({ where: { id }, include: consultationInclude });

// حفظ/تعديل رابط الاجتماع يدويًا (بدون إرسال)
router.put('/:id/meeting', auth, async (req, res, next) => {
  try {
    const id = asPositiveInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'رقم الطلب غير صالح' });
    const { consultation } = await loadManaged(req, id);

    if (req.body.auto === true || req.body.auto === 'true') {
      return res.status(400).json({ message: AUTO_MEET_DISABLED });
    }
    const { url } = readMeetUrl(req.body.meetingUrl);
    if ((url || null) !== (consultation.meetingUrl || null)) {
      await prisma.consultation.update({
        where: { id },
        data: { meetingUrl: url, ...RESET_SEND_STATE },
      });
    }
    return res.json(await loadFull(id));
  } catch (error) {
    return sendError(res, next, error);
  }
});

/**
 * حفظ الرابط وإرساله للمريض عبر واتساب.
 * body: { meetingUrl?: string, resend?: boolean }
 * الرد: { consultation, whatsapp }
 *   whatsapp.mode = 'api'  → { ok, error? } إرسال فعلي من السيرفر
 *   whatsapp.mode = 'link' → { url } رابط wa.me يفتحه التطبيق (الأخصائي يضغط إرسال)
 */
router.post('/:id/meeting/send', auth, async (req, res, next) => {
  try {
    const id = asPositiveInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'رقم الطلب غير صالح' });
    const { consultation } = await loadManaged(req, id);
    if (!MEETING_STATUSES.has(consultation.status)) {
      return res.status(409).json({ message: 'إرسال الرابط متاح للحجوزات المقبولة فقط' });
    }

    // 1) حفظ الرابط (إن أُرسل رابط جديد)
    const provided = req.body.meetingUrl !== undefined;
    const url = provided ? readMeetUrl(req.body.meetingUrl).url : consultation.meetingUrl;
    if (!url) return res.status(400).json({ message: 'أدخل رابط Google Meet أولًا' });
    if (url !== consultation.meetingUrl) {
      await prisma.consultation.update({ where: { id }, data: { meetingUrl: url, ...RESET_SEND_STATE } });
    }

    const phone = whatsappPhone(consultation.phone);
    if (!phone) {
      return res.status(422).json({
        message: 'تم حفظ الرابط، لكن لا يوجد رقم هاتف صالح للمريض لإرساله عبر واتساب',
        consultation: await loadFull(id),
      });
    }

    // 2) أُرسل نفس الرابط مسبقًا عبر API ولم يُطلب إعادة الإرسال: لا تكرار
    const fresh = await prisma.consultation.findUnique({ where: { id } });
    const resend = req.body.resend === true || req.body.resend === 'true';
    if (!resend && fresh.meetingLinkStatus === 'SENT' && fresh.meetingLinkSentUrl === url) {
      return res.json({ consultation: await loadFull(id), whatsapp: { mode: 'api', ok: true, alreadySent: true } });
    }

    // 3) قفل ذرّي ضد الضغط المتكرر/الطلبات المتزامنة
    const now = new Date();
    const claim = await prisma.consultation.updateMany({
      where: {
        id,
        OR: [
          { meetingLinkAttemptAt: null },
          { meetingLinkAttemptAt: { lt: new Date(now.getTime() - SEND_COOLDOWN_MS) } },
        ],
      },
      data: { meetingLinkAttemptAt: now, meetingLinkStatus: 'SENDING', meetingLinkError: null },
    });
    if (claim.count !== 1) {
      return res.status(429).json({ message: 'تم إرسال طلب قبل لحظات، انتظر قليلًا ثم أعد المحاولة' });
    }

    const full = await loadFull(id);
    const params = {
      patientName: full.userName || '',
      specialistName: full.specialistProfile?.displayName || full.specialist,
      dateText: formatSessionDate(full.date),
      url,
    };

    // 4أ) إرسال تلقائي عبر WhatsApp Cloud API
    if (whatsapp.isWhatsAppApiConfigured()) {
      try {
        await whatsapp.sendMeetingTemplate({ to: phone, ...params });
        await prisma.consultation.update({
          where: { id },
          data: {
            meetingLinkStatus: 'SENT',
            meetingLinkChannel: 'whatsapp_api',
            meetingLinkSentUrl: url,
            meetingLinkSentAt: new Date(),
            meetingLinkError: null,
          },
        });
        return res.json({ consultation: await loadFull(id), whatsapp: { mode: 'api', ok: true } });
      } catch (error) {
        console.error(`WHATSAPP SEND FAILED consultation=${id}:`, error.message);
        await prisma.consultation.update({
          where: { id },
          data: {
            meetingLinkStatus: 'FAILED',
            meetingLinkChannel: 'whatsapp_api',
            meetingLinkError: String(error.message).slice(0, 300),
          },
        });
        // الرابط محفوظ، والإرسال فشل: يمكن إعادة المحاولة
        return res.json({
          consultation: await loadFull(id),
          whatsapp: { mode: 'api', ok: false, error: 'تعذر إرسال رسالة واتساب، الرابط محفوظ ويمكنك إعادة الإرسال' },
        });
      }
    }

    // 4ب) بدون WhatsApp API: رسالة جاهزة تُفتح في واتساب على جهاز الأخصائي
    const text = buildMeetingMessage({
      patientName: params.patientName,
      specialistName: params.specialistName,
      date: full.date,
      url,
    });
    await prisma.consultation.update({
      where: { id },
      data: { meetingLinkStatus: 'READY', meetingLinkChannel: 'whatsapp_link', meetingLinkError: null },
    });
    return res.json({
      consultation: await loadFull(id),
      whatsapp: { mode: 'link', url: whatsapp.clickToChatUrl(phone, text), phone },
    });
  } catch (error) {
    return sendError(res, next, error);
  }
});

// يسجّل أن التطبيق فتح واتساب بالرسالة الجاهزة (وضع wa.me). لا يعني تأكيد الإرسال.
router.post('/:id/meeting/opened', auth, async (req, res, next) => {
  try {
    const id = asPositiveInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'رقم الطلب غير صالح' });
    const { consultation } = await loadManaged(req, id);
    if (!consultation.meetingUrl) return res.status(400).json({ message: 'لا يوجد رابط اجتماع' });
    await prisma.consultation.update({
      where: { id },
      data: {
        meetingLinkStatus: 'OPENED',
        meetingLinkChannel: 'whatsapp_link',
        meetingLinkSentUrl: consultation.meetingUrl,
        meetingLinkSentAt: new Date(),
        meetingLinkError: null,
      },
    });
    return res.json(await loadFull(id));
  } catch (error) {
    return sendError(res, next, error);
  }
});

// نقل حجز إلى موعد آخر متاح (تصبح الحالة: تم تغيير الموعد)
router.put('/:id/reschedule', auth, async (req, res, next) => {
  try {
    const id = asPositiveInt(req.params.id);
    const availabilityId = asPositiveInt(req.body.availabilityId);
    if (!id || !availabilityId) {
      return res.status(400).json({ message: 'اختر الموعد الجديد' });
    }
    const { consultation: current } = await loadManaged(req, id);

    const updated = await prisma.$transaction(async (tx) => {
      if (!ACTIVE_STATUSES.includes(current.status)) {
        throw new HttpError(409, 'لا يمكن تغيير موعد طلب منتهٍ أو ملغى');
      }
      const target = await tx.specialistAvailability.findUnique({ where: { id: availabilityId } });
      if (!target || (target.specialistProfileId || null) !== (current.specialistProfileId || null)) {
        throw new HttpError(409, 'اختر موعدًا من مواعيد نفس الأخصائي');
      }

      const locked = await tx.specialistAvailability.updateMany({
        where: { id: availabilityId, isAvailable: true, status: 'AVAILABLE', startAt: { gt: new Date() } },
        data: { isAvailable: false, status: 'BOOKED' },
      });
      if (locked.count !== 1) {
        throw new HttpError(409, 'الموعد الجديد غير متاح، اختر موعدًا آخر');
      }

      if (current.availabilityId && current.availabilityId !== availabilityId) {
        const old = await tx.specialistAvailability.findUnique({ where: { id: current.availabilityId } });
        if (old) {
          await tx.specialistAvailability.update({
            where: { id: old.id },
            data: {
              isAvailable: old.startAt > new Date(),
              status: old.startAt > new Date() ? 'AVAILABLE' : 'CANCELLED',
            },
          });
        }
      }

      return tx.consultation.update({
        where: { id },
        data: {
          availabilityId,
          specialist: target.specialist,
          date: target.startAt,
          time: target.startAt.toISOString().slice(11, 16),
          status: 'CHANGED',
          // رابط Meet اليدوي يبقى صالحًا، لكن الموعد تغيّر: يجب إعادة إرساله للمريض
          meetingLinkStatus: null,
          meetingLinkSentAt: null,
          meetingLinkSentUrl: null,
          meetingLinkError: null,
        },
      });
    });

    return res.json(await prisma.consultation.findUnique({ where: { id: updated.id }, include: consultationInclude }));
  } catch (error) {
    return sendError(res, next, error);
  }
});

module.exports = router;
