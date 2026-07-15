const express = require('express');
const prisma = require('../config/prisma');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();
const allowedStatuses = new Set(['NEW', 'ACCEPTED', 'REJECTED', 'CHANGED']);

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
