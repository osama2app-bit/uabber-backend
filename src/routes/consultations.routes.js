const express = require('express');
const prisma = require('../config/prisma');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();
const allowedStatuses = new Set(['NEW', 'ACCEPTED', 'REJECTED', 'CHANGED']);
const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

function normalizeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function validateAvailabilityInput(body) {
  const specialistName = String(body.specialistName || '').trim();
  const availableDate = normalizeDate(body.availableDate);
  const startTime = String(body.startTime || '').trim();

  if (!specialistName) return { error: 'Specialist name is required' };
  if (!availableDate) return { error: 'Valid available date is required' };
  if (!timePattern.test(startTime)) return { error: 'Time must use HH:mm format' };

  return { specialistName, availableDate, startTime };
}

router.get('/availability', auth, async (req, res, next) => {
  try {
    const specialistName = String(req.query.specialist || '').trim();
    if (!specialistName) {
      return res.status(400).json({ message: 'Specialist is required' });
    }

    const from = req.query.from ? normalizeDate(req.query.from) : normalizeDate(new Date());
    if (!from) return res.status(400).json({ message: 'Invalid from date' });

    const rows = await prisma.specialistAvailability.findMany({
      where: {
        specialistName,
        availableDate: { gte: from },
        isAvailable: true,
      },
      orderBy: [{ availableDate: 'asc' }, { startTime: 'asc' }],
    });

    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.get('/availability/admin/all', auth, adminOnly, async (req, res, next) => {
  try {
    const specialistName = String(req.query.specialist || '').trim();
    const rows = await prisma.specialistAvailability.findMany({
      where: specialistName ? { specialistName } : undefined,
      orderBy: [{ availableDate: 'asc' }, { startTime: 'asc' }],
    });
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.post('/availability', auth, adminOnly, async (req, res, next) => {
  try {
    const parsed = validateAvailabilityInput(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });

    const row = await prisma.specialistAvailability.upsert({
      where: {
        specialistName_availableDate_startTime: {
          specialistName: parsed.specialistName,
          availableDate: parsed.availableDate,
          startTime: parsed.startTime,
        },
      },
      create: {
        specialistName: parsed.specialistName,
        availableDate: parsed.availableDate,
        startTime: parsed.startTime,
        isAvailable: req.body.isAvailable !== false && req.body.isAvailable !== 'false',
      },
      update: {
        isAvailable: req.body.isAvailable !== false && req.body.isAvailable !== 'false',
      },
    });

    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
});

router.put('/availability/:id', auth, adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Invalid availability id' });
    }

    const data = {};
    if (req.body.specialistName !== undefined) {
      const specialistName = String(req.body.specialistName).trim();
      if (!specialistName) return res.status(400).json({ message: 'Specialist name is required' });
      data.specialistName = specialistName;
    }
    if (req.body.availableDate !== undefined) {
      const availableDate = normalizeDate(req.body.availableDate);
      if (!availableDate) return res.status(400).json({ message: 'Invalid available date' });
      data.availableDate = availableDate;
    }
    if (req.body.startTime !== undefined) {
      const startTime = String(req.body.startTime).trim();
      if (!timePattern.test(startTime)) return res.status(400).json({ message: 'Time must use HH:mm format' });
      data.startTime = startTime;
    }
    if (req.body.isAvailable !== undefined) {
      data.isAvailable = req.body.isAvailable === true || req.body.isAvailable === 'true';
    }

    const row = await prisma.specialistAvailability.update({ where: { id }, data });
    res.json(row);
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ message: 'Availability slot not found' });
    if (error.code === 'P2002') return res.status(409).json({ message: 'This slot already exists' });
    next(error);
  }
});

router.delete('/availability/:id', auth, adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Invalid availability id' });
    }
    await prisma.specialistAvailability.delete({ where: { id } });
    res.json({ ok: true });
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ message: 'Availability slot not found' });
    next(error);
  }
});

router.post('/', auth, async (req, res, next) => {
  try {
    const specialist = String(req.body.specialist || '').trim();
    const message = String(req.body.message || '').trim();
    if (!specialist) return res.status(400).json({ message: 'Specialist required' });

    const consultation = await prisma.$transaction(async (tx) => {
      const created = await tx.consultation.create({
        data: {
          userId: req.user.id,
          userName: req.user.fullName,
          userEmail: req.user.email,
          specialist,
          message: message || null,
          date: req.body.date ? new Date(req.body.date) : null,
          time: req.body.time ? String(req.body.time) : null,
        },
      });
      await tx.adminNotification.create({
        data: {
          title: 'طلب استشارة جديد',
          body: `${req.user.fullName} - ${specialist}`,
          type: 'consultation',
          sourceId: created.id,
          route: '/admin/consultations',
        },
      });
      return created;
    });
    res.status(201).json(consultation);
  } catch (error) {
    next(error);
  }
});

router.get('/', auth, adminOnly, async (req, res, next) => {
  try {
    res.json(await prisma.consultation.findMany({ orderBy: { id: 'desc' } }));
  } catch (error) {
    next(error);
  }
});

router.put('/:id/status', auth, adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const status = String(req.body.status || '').toUpperCase();
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid consultation id' });
    if (!allowedStatuses.has(status)) return res.status(400).json({ message: 'Invalid consultation status' });

    const updated = await prisma.$transaction(async (tx) => {
      const consultation = await tx.consultation.update({
        where: { id },
        data: {
          status,
          date: req.body.date ? new Date(req.body.date) : undefined,
          time: req.body.time !== undefined ? String(req.body.time || '') || null : undefined,
        },
      });
      if (status !== 'NEW') {
        await tx.adminNotification.deleteMany({ where: { type: 'consultation', sourceId: id } });
      }
      return consultation;
    });
    res.json(updated);
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ message: 'Consultation not found' });
    next(error);
  }
});

module.exports = router;
