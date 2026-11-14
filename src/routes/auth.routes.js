const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const prisma = require('../config/prisma');
const { auth } = require('../middleware/auth');
const { isMailConfigured, sendMail } = require('../utils/mailer');

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
      return res.status(400).json({ message: 'يرجى تعبئة جميع الحقول' });
    }

    const cleanName = String(fullName).trim();
    const normalizedEmail = String(email).trim().toLowerCase();

    if (cleanName.length < 2) {
      return res.status(400).json({ message: 'الاسم قصير جدًا' });
    }

    if (String(password).length < 8) {
      return res.status(400).json({
        message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل',
      });
    }

    const exists = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (exists) {
      return res.status(409).json({ message: 'هذا البريد الإلكتروني مسجّل مسبقًا' });
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
      return res.status(400).json({ message: 'يرجى إدخال البريد الإلكتروني وكلمة المرور' });
    }

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    // Same response for unknown email and wrong password.
    if (!user) {
      return res.status(401).json({ message: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
    }

    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) {
      return res.status(401).json({ message: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
    }

    if (!user.isActive) {
      return res.status(403).json({ message: 'تم إيقاف هذا الحساب، تواصل مع الدعم الفني' });
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
    const user = await prisma.user.findUnique({
      where: {
        id: req.user.id,
      },
    });

    if (!user) {
      return res.status(404).json({
        message: 'User not found',
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        message: 'Account suspended',
      });
    }

    const access = await buildAccessState(user);

    return res.json({
      user: publicUser(user),
      access,
    });
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

// ---------------------------------------------------------------------------
// استعادة كلمة المرور وتغييرها
// ---------------------------------------------------------------------------
const RESET_CODE_TTL_MIN = 15;
const RESET_MAX_ATTEMPTS = 5;
const MIN_PASSWORD = 8;

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'محاولات كثيرة، حاول بعد قليل' },
});

function hashCode(code) {
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'uabber')
    .update(String(code))
    .digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function setPassword(userId, newPassword) {
  const passwordHash = await bcrypt.hash(String(newPassword), 12);
  // نطرح ثانية حتى تبقى الجلسة الجديدة صالحة بينما تُلغى كل الجلسات القديمة.
  const changedAt = new Date(Date.now() - 1000);
  return prisma.user.update({
    where: { id: userId },
    data: { passwordHash, passwordChangedAt: changedAt },
  });
}

// 1) طلب رمز الاستعادة: يُرسل رمز من 6 أرقام إلى البريد
router.post('/forgot-password', resetLimiter, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ message: 'يرجى إدخال البريد الإلكتروني' });
    }
    if (!isMailConfigured()) {
      return res.status(503).json({
        message: 'استعادة كلمة المرور عبر البريد غير مفعّلة حاليًا، تواصل مع الدعم الفني لإعادة تعيينها',
      });
    }

    // نفس الرد دائمًا حتى لا نكشف هل البريد مسجّل أم لا.
    const generic = {
      ok: true,
      message: 'إذا كان البريد مسجّلًا لدينا فستصلك رسالة فيها رمز الاستعادة خلال دقائق',
    };

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) return res.json(generic);

    const recent = await prisma.passwordResetCode.findFirst({
      where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 60 * 1000) } },
    });
    if (recent) return res.json(generic);

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await prisma.passwordResetCode.create({
      data: {
        userId: user.id,
        codeHash: hashCode(code),
        expiresAt: new Date(Date.now() + RESET_CODE_TTL_MIN * 60 * 1000),
      },
    });

    try {
      await sendMail({
        to: user.email,
        subject: 'رمز استعادة كلمة المرور - أُعبر',
        text: `رمز استعادة كلمة المرور: ${code}\nصالح لمدة ${RESET_CODE_TTL_MIN} دقيقة.\nإذا لم تطلب ذلك فتجاهل هذه الرسالة.`,
        html: `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:16px">
<p>رمز استعادة كلمة المرور في تطبيق أُعبر:</p>
<p style="font-size:30px;font-weight:bold;letter-spacing:6px">${code}</p>
<p>الرمز صالح لمدة ${RESET_CODE_TTL_MIN} دقيقة. إذا لم تطلب ذلك فتجاهل هذه الرسالة.</p></div>`,
      });
    } catch (mailError) {
      console.error('RESET MAIL ERROR:', mailError.message);
      return res.status(502).json({ message: 'تعذر إرسال البريد الآن، حاول لاحقًا' });
    }

    return res.json(generic);
  } catch (error) {
    return next(error);
  }
});

// 2) تعيين كلمة مرور جديدة بالرمز، ثم تسجيل الدخول تلقائيًا
router.post('/reset-password', resetLimiter, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();
    const newPassword = String(req.body.newPassword || '');

    if (!email || !code) {
      return res.status(400).json({ message: 'يرجى إدخال البريد والرمز' });
    }
    if (newPassword.length < MIN_PASSWORD) {
      return res.status(400).json({ message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
    }

    const invalid = { message: 'الرمز غير صحيح أو منتهي الصلاحية' };
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) return res.status(400).json(invalid);

    const record = await prisma.passwordResetCode.findFirst({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!record || record.attempts >= RESET_MAX_ATTEMPTS) {
      return res.status(400).json(invalid);
    }

    if (!safeEqual(record.codeHash, hashCode(code))) {
      await prisma.passwordResetCode.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      return res.status(400).json(invalid);
    }

    const updated = await setPassword(user.id, newPassword);
    await prisma.passwordResetCode.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const access = await buildAccessState(updated);
    return res.json({ token: sign(updated), user: publicUser(updated), access });
  } catch (error) {
    return next(error);
  }
});

// تغيير كلمة المرور من داخل الحساب
router.put('/change-password', auth, async (req, res, next) => {
  try {
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');
    if (newPassword.length < MIN_PASSWORD) {
      return res.status(400).json({ message: 'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const ok = user && (await bcrypt.compare(currentPassword, user.passwordHash));
    if (!ok) {
      return res.status(400).json({ message: 'كلمة المرور الحالية غير صحيحة' });
    }

    const updated = await setPassword(user.id, newPassword);
    const access = await buildAccessState(updated);
    return res.json({ token: sign(updated), user: publicUser(updated), access });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
