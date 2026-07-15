const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');
const { auth } = require('../middleware/auth');

const router = express.Router();

const ACTIVE = 'active';
const EXPIRED = 'expired';

function sign(user) {
  return jwt.sign(
    { id: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '365d' }
  );
}

function publicUser(user) {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    trialStartDate: user.trialStartDate,
    trialExpiryDate: user.trialExpiryDate,
    createdAt: user.createdAt,
  };
}

async function buildAccessState(user) {
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

  const now = new Date();

  await prisma.subscription.updateMany({
    where: {
      userId: user.id,
      status: ACTIVE,
      expiryDate: { lte: now },
    },
    data: { status: EXPIRED },
  });

  const subscription = await prisma.subscription.findFirst({
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

router.post('/register', async (req, res, next) => {
  try {
    const { fullName, email, password } = req.body;

    if (!fullName || !email || !password) {
      return res.status(400).json({ message: 'Missing fields' });
    }

    const cleanName = String(fullName).trim();
    const normalizedEmail = String(email).trim().toLowerCase();

    if (cleanName.length < 2) {
      return res.status(400).json({ message: 'Full name is too short' });
    }

    if (String(password).length < 8) {
      return res.status(400).json({
        message: 'Password must contain at least 8 characters',
      });
    }

    const exists = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (exists) {
      return res.status(409).json({ message: 'Email already exists' });
    }

    const trialStartDate = new Date();
    const trialExpiryDate = new Date(trialStartDate);
    trialExpiryDate.setUTCDate(trialExpiryDate.getUTCDate() + 30);

    const passwordHash = await bcrypt.hash(String(password), 12);
    const user = await prisma.user.create({
      data: {
        fullName: cleanName,
        email: normalizedEmail,
        passwordHash,
        trialStartDate,
        trialExpiryDate,
      },
    });

    const access = await buildAccessState(user);

    return res.status(201).json({
      token: sign(user),
      user: publicUser(user),
      access,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();

    if (!normalizedEmail || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    // Same response for unknown email and wrong password.
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (!user.isActive) {
      return res.status(403).json({ message: 'Account suspended' });
    }

    const access = await buildAccessState(user);

    return res.json({
      token: sign(user),
      user: publicUser(user),
      access,
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/me', auth, async (req, res, next) => {
  try {
    const access = await buildAccessState(req.user);
    return res.json({ user: publicUser(req.user), access });
  } catch (error) {
    return next(error);
  }
});

router.delete('/delete-account', auth, async (req, res, next) => {
  try {
    await prisma.user.delete({
      where: { id: req.user.id },
    });

    return res.json({
      ok: true,
      message: 'Account deleted successfully',
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
