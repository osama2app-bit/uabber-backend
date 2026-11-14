const express = require('express');
const prisma = require('../config/prisma');
const { auth, adminOnly } = require('../middleware/auth');
const { makeUpload, fileUrl } = require('../utils/upload');

const router = express.Router();

const BEHAVIOR_SPECIALIST = 'أخصائي/ة تعديل سلوك';
const SPEECH_SPECIALIST = 'أخصائي/ة نطق';
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

// يمنع تداخل المواعيد لنفس الأخصائي (وليس التطابق التام فقط):
// أي موعد يبدأ قبل نهاية موعد آخر وينتهي بعد بدايته يُعتبر متداخلًا.
async function findOverlap(db, specialist, startAt, durationMinutes, excludeId) {
  const ms = durationMinutes * 60 * 1000;
  return db.specialistAvailability.findFirst({
    where: {
      specialist,
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

const ACTIVE_STATUSES = ['NEW', 'PAYMENT_CONFIRMED', 'ACCEPTED', 'CHANGED'];

// طلبات المستخدم وحالتها
router.get('/mine', auth, async (req, res, next) => {
  try {
    const rows = await prisma.consultation.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true, specialist: true, status: true, rejectionReason: true,
        date: true, durationMinutes: true, priceJod: true, createdAt: true,
      },
    });
    return res.json(rows);
  } catch (error) {
    return next(error);
  }
});

router.get('/availability', auth, async (req, res, next) => {
  try {
    const requestedSpecialist = String(req.query.specialist || '').trim();
    const where = {
      isAvailable: true,
      startAt: { gt: new Date() },
      ...(requestedSpecialist ? { specialist: requestedSpecialist } : {}),
    };

    const slots = await prisma.specialistAvailability.findMany({
      where,
      orderBy: { startAt: 'asc' },
    });

    return res.json(slots);
  } catch (error) {
    return next(error);
  }
});

router.get('/availability/admin', auth, adminOnly, async (_req, res, next) => {
  try {
    const slots = await prisma.specialistAvailability.findMany({
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

// إنشاء موعد منفرد للتوافق مع النسخ القديمة، أو إنشاء مجموعة مواعيد جديدة.
router.post('/availability', auth, adminOnly, async (req, res, next) => {
  try {
    const specialist = String(req.body.specialist || '').trim();

    if (!ALLOWED_SPECIALISTS.has(specialist)) {
      return res.status(400).json({ message: 'نوع الاستشارة غير صالح' });
    }

    if (specialist === SPEECH_SPECIALIST) {
      return res.status(409).json({ message: 'استشارات النطق غير متوفرة حاليًا' });
    }

    const isBulkRequest = Array.isArray(req.body.weekdays);

    if (!isBulkRequest) {
      const startAt = new Date(req.body.startAt);
      if (Number.isNaN(startAt.getTime()) || startAt <= new Date()) {
        return res.status(400).json({ message: 'يجب اختيار موعد مستقبلي صالح' });
      }

      const overlap = await findOverlap(prisma, specialist, startAt, SESSION_DURATION_MINUTES);
      if (overlap) {
        return res.status(409).json({ message: 'يوجد موعد آخر متداخل مع هذا الوقت' });
      }

      const slot = await prisma.specialistAvailability.create({
        data: {
          specialist,
          startAt,
          durationMinutes: SESSION_DURATION_MINUTES,
          isAvailable: req.body.isAvailable !== false,
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
          currentMinutes + SESSION_DURATION_MINUTES <= endTime.totalMinutes
        ) {
          const startAt = localDateTimeToUtc(currentDate, currentMinutes, utcOffsetMinutes);
          if (startAt > new Date()) starts.push(startAt);

          currentMinutes += SESSION_DURATION_MINUTES;
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

    // استبعاد ما يتداخل مع مواعيد موجودة مسبقًا
    const rangeMs = SESSION_DURATION_MINUTES * 60 * 1000;
    const existing = await prisma.specialistAvailability.findMany({
      where: {
        specialist,
        startAt: {
          gt: new Date(starts[0].getTime() - rangeMs),
          lt: new Date(starts[starts.length - 1].getTime() + rangeMs),
        },
      },
      select: { startAt: true },
    });
    const existingStarts = existing.map((e) => e.startAt.getTime());
    const freeStarts = starts.filter(
      (startAt) => !overlapsAny(startAt, existingStarts, SESSION_DURATION_MINUTES)
    );
    if (freeStarts.length === 0) {
      return res.status(409).json({
        message: 'كل هذه المواعيد موجودة مسبقًا أو متداخلة مع مواعيد أخرى',
      });
    }

    const result = await prisma.specialistAvailability.createMany({
      data: freeStarts.map((startAt) => ({
        specialist,
        startAt,
        durationMinutes: SESSION_DURATION_MINUTES,
        isAvailable: true,
      })),
      skipDuplicates: true,
    });

    return res.status(201).json({
      createdCount: result.count,
      requestedCount: starts.length,
      skippedCount: starts.length - result.count,
      durationMinutes: SESSION_DURATION_MINUTES,
      priceJod: SESSION_PRICE_JOD,
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ message: 'هذا الموعد مضاف مسبقًا' });
    }
    return next(error);
  }
});

router.put('/availability/:id', auth, adminOnly, async (req, res, next) => {
  try {
    const id = asPositiveInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'رقم الموعد غير صالح' });

    const current = await prisma.specialistAvailability.findUnique({ where: { id } });
    if (!current) return res.status(404).json({ message: 'الموعد غير موجود' });

    const data = {};
    if (req.body.specialist !== undefined) {
      const specialist = String(req.body.specialist).trim();
      if (!ALLOWED_SPECIALISTS.has(specialist)) {
        return res.status(400).json({ message: 'نوع الاستشارة غير صالح' });
      }
      if (specialist === SPEECH_SPECIALIST) {
        return res.status(409).json({ message: 'استشارات النطق غير متوفرة حاليًا' });
      }
      data.specialist = specialist;
    }

    if (req.body.startAt !== undefined) {
      const startAt = new Date(req.body.startAt);
      if (Number.isNaN(startAt.getTime()) || startAt <= new Date()) {
        return res.status(400).json({ message: 'الموعد غير صالح' });
      }
      const overlap = await findOverlap(
        prisma, data.specialist || current.specialist, startAt, current.durationMinutes, id
      );
      if (overlap) {
        return res.status(409).json({ message: 'يوجد موعد آخر متداخل مع هذا الوقت' });
      }
      data.startAt = startAt;
    }

    if (req.body.durationMinutes !== undefined && Number(req.body.durationMinutes) !== SESSION_DURATION_MINUTES) {
      return res.status(400).json({ message: 'مدة الجلسة ثابتة: 45 دقيقة' });
    }

    if (req.body.isAvailable !== undefined) {
      data.isAvailable = Boolean(req.body.isAvailable);
    }

    const slot = await prisma.specialistAvailability.update({
      where: { id },
      data,
    });

    return res.json(slot);
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ message: 'هذا الموعد مضاف مسبقًا' });
    }
    return next(error);
  }
});

router.delete('/availability/:id', auth, adminOnly, async (req, res, next) => {
  try {
    const id = asPositiveInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'رقم الموعد غير صالح' });

    const activeBooking = await prisma.consultation.findFirst({
      where: {
        availabilityId: id,
        status: { notIn: ['REJECTED', 'CANCELLED'] },
      },
    });

    if (activeBooking) {
      return res.status(409).json({ message: 'لا يمكن حذف موعد مرتبط بطلب فعال' });
    }

    await prisma.specialistAvailability.delete({ where: { id } });
    return res.status(204).send();
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ message: 'الموعد غير موجود' });
    }
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
      });

      if (!slot || !slot.isAvailable || slot.startAt <= new Date()) {
        const error = new Error('عذرًا، هذا الموعد غير متاح. يرجى اختيار موعد مختلف.');
        error.statusCode = 409;
        throw error;
      }

      if (slot.specialist === SPEECH_SPECIALIST) {
        const error = new Error('استشارات النطق غير متوفرة حاليًا');
        error.statusCode = 409;
        throw error;
      }

      const locked = await tx.specialistAvailability.updateMany({
        where: { id: availabilityId, isAvailable: true },
        data: { isAvailable: false },
      });

      if (locked.count !== 1) {
        const error = new Error('عذرًا، تم حجز هذا الموعد من عميل آخر. يرجى اختيار موعد مختلف.');
        error.statusCode = 409;
        throw error;
      }

      const created = await tx.consultation.create({
        data: {
          userId: req.user.id,
          availabilityId: slot.id,
          userName,
          userEmail: req.user.email,
          phone,
          specialist: slot.specialist,
          message: message || null,
          receiptUrl,
          durationMinutes: SESSION_DURATION_MINUTES,
          priceJod: SESSION_PRICE_JOD,
          date: slot.startAt,
          time: slot.startAt.toISOString().slice(11, 16),
        },
      });

      await tx.adminNotification.create({
        data: {
          title: 'طلب استشارة جديد',
          body: `${userName} - ${slot.specialist} - ${SESSION_DURATION_MINUTES} دقيقة`,
          type: 'consultation',
          sourceId: created.id,
          route: '/admin/consultations',
        },
      });

      return created;
    });

    return res.status(201).json(consultation);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    return next(error);
  }
});

router.get('/', auth, adminOnly, async (_req, res, next) => {
  try {
    const consultations = await prisma.consultation.findMany({
      orderBy: { id: 'desc' },
      include: { availability: true },
    });

    return res.json(consultations);
  } catch (error) {
    return next(error);
  }
});

router.put('/:id/status', auth, adminOnly, async (req, res, next) => {
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

    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.consultation.findUnique({ where: { id } });
      if (!existing) {
        const error = new Error('طلب الاستشارة غير موجود');
        error.statusCode = 404;
        throw error;
      }

      const consultation = await tx.consultation.update({
        where: { id },
        data: {
          status,
          rejectionReason: status === 'REJECTED' ? rejectionReason : null,
        },
      });

      if (reusableStatuses.has(status) && existing.availabilityId) {
        await tx.specialistAvailability.update({
          where: { id: existing.availabilityId },
          data: {
            isAvailable: Boolean(existing.date && existing.date > new Date()),
          },
        });
      }

      if (status !== 'NEW') {
        await tx.adminNotification.deleteMany({
          where: { type: 'consultation', sourceId: id },
        });
      }

      return consultation;
    });

    return res.json(updated);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    return next(error);
  }
});

// حذف عدة مواعيد فارغة دفعة واحدة (المحجوزة لا تُحذف)
router.post('/availability/bulk-delete', auth, adminOnly, async (req, res, next) => {
  try {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : [])
      .map(asPositiveInt)
      .filter(Boolean)
      .slice(0, 500);
    if (!ids.length) return res.status(400).json({ message: 'لم يتم اختيار مواعيد' });

    const booked = await prisma.consultation.findMany({
      where: { availabilityId: { in: ids }, status: { notIn: ['REJECTED', 'CANCELLED'] } },
      select: { availabilityId: true },
    });
    const bookedIds = new Set(booked.map((b) => b.availabilityId));
    const deletable = ids.filter((id) => !bookedIds.has(id));

    // نفك ارتباط الطلبات الملغاة/المرفوضة القديمة قبل الحذف
    await prisma.consultation.updateMany({
      where: { availabilityId: { in: deletable } },
      data: { availabilityId: null },
    });
    const result = await prisma.specialistAvailability.deleteMany({
      where: { id: { in: deletable } },
    });
    return res.json({ deletedCount: result.count, skippedBooked: bookedIds.size });
  } catch (error) {
    return next(error);
  }
});

// نقل حجز إلى موعد آخر متاح (تصبح الحالة: تم تغيير الموعد)
router.put('/:id/reschedule', auth, adminOnly, async (req, res, next) => {
  try {
    const id = asPositiveInt(req.params.id);
    const availabilityId = asPositiveInt(req.body.availabilityId);
    if (!id || !availabilityId) {
      return res.status(400).json({ message: 'اختر الموعد الجديد' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const consultation = await tx.consultation.findUnique({ where: { id } });
      if (!consultation) {
        const error = new Error('طلب الاستشارة غير موجود');
        error.statusCode = 404;
        throw error;
      }
      if (!ACTIVE_STATUSES.includes(consultation.status)) {
        const error = new Error('لا يمكن تغيير موعد طلب منتهٍ أو ملغى');
        error.statusCode = 409;
        throw error;
      }

      const locked = await tx.specialistAvailability.updateMany({
        where: { id: availabilityId, isAvailable: true, startAt: { gt: new Date() } },
        data: { isAvailable: false },
      });
      if (locked.count !== 1) {
        const error = new Error('الموعد الجديد غير متاح، اختر موعدًا آخر');
        error.statusCode = 409;
        throw error;
      }

      if (consultation.availabilityId && consultation.availabilityId !== availabilityId) {
        const old = await tx.specialistAvailability.findUnique({
          where: { id: consultation.availabilityId },
        });
        if (old) {
          await tx.specialistAvailability.update({
            where: { id: old.id },
            data: { isAvailable: old.startAt > new Date() },
          });
        }
      }

      const slot = await tx.specialistAvailability.findUnique({ where: { id: availabilityId } });
      return tx.consultation.update({
        where: { id },
        data: {
          availabilityId,
          specialist: slot.specialist,
          date: slot.startAt,
          time: slot.startAt.toISOString().slice(11, 16),
          status: 'CHANGED',
        },
        include: { availability: true },
      });
    });

    return res.json(updated);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    return next(error);
  }
});

module.exports = router;
