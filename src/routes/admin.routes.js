const express = require('express');
const prisma = require('../config/prisma');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();

router.get('/users', auth, adminOnly, async (req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { id: 'desc' },
    select: {
      id: true,
      fullName: true,
      email: true,
      role: true,
      isActive: true,
      trialExpiryDate: true,
      createdAt: true,
    },
  });

  res.json(users);
});

router.put('/users/:id/toggle', auth, adminOnly, async (req, res) => {
  const u = await prisma.user.findUnique({
    where: {
      id: Number(req.params.id),
    },
  });

  if (!u || u.role === 'ADMIN') {
    return res.status(400).json({
      message: 'Cannot modify',
    });
  }

  const updated = await prisma.user.update({
    where: {
      id: u.id,
    },
    data: {
      isActive: !u.isActive,
    },
  });

  res.json(updated);
});

// إعادة تعيين كلمة مرور مستخدم من الأدمن (عند نسيانها وعدم توفر البريد)
router.put('/users/:id/password', auth, adminOnly, async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const newPassword = String(req.body.newPassword || '');
    if (newPassword.length < 8) {
      return res.status(400).json({ message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
    }
    const user = await prisma.user.findUnique({ where: { id: Number(req.params.id) } });
    if (!user) return res.status(404).json({ message: 'المستخدم غير موجود' });

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(newPassword, 12),
        passwordChangedAt: new Date(),
      },
    });
    res.json({ ok: true, message: 'تم تعيين كلمة المرور الجديدة' });
  } catch (error) {
    console.error('ADMIN RESET PASSWORD ERROR:', error);
    res.status(500).json({ message: 'تعذر تعيين كلمة المرور' });
  }
});

router.delete('/users/:id', auth, adminOnly, async (req, res) => {
  const id = Number(req.params.id);

  const user = await prisma.user.findUnique({
    where: {
      id,
    },
  });

  if (!user) {
    return res.status(404).json({
      message: 'User not found',
    });
  }

  if (user.role === 'ADMIN') {
    return res.status(400).json({
      message: 'Cannot delete admin',
    });
  }

  await prisma.user.delete({
    where: {
      id,
    },
  });

  res.json({
    ok: true,
    message: 'User deleted successfully',
  });
});

router.get('/stats', auth, adminOnly, async (req, res) => {
  const [
    users,
    activeUsers,
    categories,
    items,
    pendingSubscriptions,
    consultations,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({
      where: {
        isActive: true,
      },
    }),
    prisma.category.count(),
    prisma.item.count(),
    prisma.paymentRequest.count({
      where: {
        status: 'PENDING',
      },
    }),
    prisma.consultation.count({
      where: {
        status: 'NEW',
      },
    }),
  ]);

  res.json({
    users,
    activeUsers,
    categories,
    items,
    pendingSubscriptions,
    consultations,
  });
});

module.exports = router;