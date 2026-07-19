const express = require('express');
const prisma = require('../config/prisma');
const { auth, adminOnly } = require('../middleware/auth');
const { makeUpload, fileUrl } = require('../utils/upload');

const router = express.Router();
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

router.get('/availability', auth, async (_req, res, next) => {
  try {
    const slots = await prisma.specialistAvailability.findMany({
      where: { isAvailable: true, startAt: { gt: new Date() } },
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

router.post('/availability', auth, adminOnly, async (req, res, next) => {
  try {
    const specialist = String(req.body.specialist || '').trim();
    const startAt = new Date(req.body.startAt);
    const durationMinutes = Number(req.body.durationMinutes);
    if (!specialist || Number.isNaN(startAt.getTime())) {
      return res.status(400).json({ message: 'المختص والموعد مطلوبان' });
    }
    if (![30, 60].includes(durationMinutes)) {
      return res.status(400).json({ message: 'مدة الموعد يجب أن تكون 30 أو 60 دقيقة' });
    }
    if (startAt <= new Date()) {
      return res.status(400).json({ message: 'يجب اختيار موعد مستقبلي' });
    }
    const slot = await prisma.specialistAvailability.create({
      data: { specialist, startAt, durationMinutes, isAvailable: req.body.isAvailable !== false },
    });
    return res.status(201).json(slot);
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
    if (req.body.specialist !== undefined) data.specialist = String(req.body.specialist).trim();
    if (req.body.startAt !== undefined) {
      const startAt = new Date(req.body.startAt);
      if (Number.isNaN(startAt.getTime()) || startAt <= new Date()) {
        return res.status(400).json({ message: 'الموعد غير صالح' });
      }
      data.startAt = startAt;
    }
    if (req.body.durationMinutes !== undefined) {
      const duration = Number(req.body.durationMinutes);
      if (![30, 60].includes(duration)) {
        return res.status(400).json({ message: 'مدة الموعد يجب أن تكون 30 أو 60 دقيقة' });
      }
      data.durationMinutes = duration;
    }
    if (req.body.isAvailable !== undefined) data.isAvailable = Boolean(req.body.isAvailable);

    const slot = await prisma.specialistAvailability.update({ where: { id }, data });
    return res.json(slot);
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ message: 'هذا الموعد مضاف مسبقًا' });
    return next(error);
  }
});

router.delete('/availability/:id', auth, adminOnly, async (req, res, next) => {
  try {
    const id = asPositiveInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'رقم الموعد غير صالح' });
    const activeBooking = await prisma.consultation.findFirst({
      where: { availabilityId: id, status: { notIn: ['REJECTED', 'CANCELLED'] } },
    });
    if (activeBooking) {
      return res.status(409).json({ message: 'لا يمكن حذف موعد مرتبط بطلب فعال' });
    }
    await prisma.specialistAvailability.delete({ where: { id } });
    return res.status(204).send();
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ message: 'الموعد غير موجود' });
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
      const slot = await tx.specialistAvailability.findUnique({ where: { id: availabilityId } });
      if (!slot || !slot.isAvailable || slot.startAt <= new Date()) {
        const error = new Error('عذرًا، هذا الموعد غير متاح. يرجى اختيار موعد مختلف.');
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

      const priceJod = slot.durationMinutes === 60 ? 10 : 5;
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
          durationMinutes: slot.durationMinutes,
          priceJod,
          date: slot.startAt,
          time: slot.startAt.toISOString().slice(11, 16),
        },
      });

      await tx.adminNotification.create({
        data: {
          title: 'طلب استشارة جديد',
          body: `${userName} - ${slot.specialist} - ${slot.durationMinutes} دقيقة`,
          type: 'consultation',
          sourceId: created.id,
          route: '/admin/consultations',
        },
      });
      return created;
    });

    return res.status(201).json(consultation);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
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
    if (!allowedStatuses.has(status)) return res.status(400).json({ message: 'حالة الطلب غير صالحة' });
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
          data: { isAvailable: Boolean(existing.date && existing.date > new Date()) },
        });
      }
      if (status !== 'NEW') {
        await tx.adminNotification.deleteMany({ where: { type: 'consultation', sourceId: id } });
      }
      return consultation;
    });
    return res.json(updated);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    return next(error);
  }
});

module.exports = router;
