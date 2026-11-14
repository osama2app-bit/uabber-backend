// خطط الاشتراك وإعدادات الدفع (CliQ) — يديرها الأدمن من لوحة التحكم.
const express = require('express');
const prisma = require('../config/prisma');
const { auth, adminOnly } = require('../middleware/auth');

const plansRouter = express.Router();
const settingsRouter = express.Router();

const DURATION_TYPES = ['months', 'days'];
const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';

function cleanText(value, max) {
  if (value === undefined || value === null) return undefined;
  return String(value).trim().slice(0, max);
}

function planInput(body, partial) {
  const data = {};
  const errors = [];

  if (!partial || body.name !== undefined) {
    const name = cleanText(body.name, 80);
    if (!name) errors.push('اسم الخطة مطلوب');
    else data.name = name;
  }
  if (body.description !== undefined) {
    data.description = cleanText(body.description, 300) || null;
  }
  if (!partial || body.price !== undefined) {
    const price = cleanText(body.price, 20);
    if (!price || !/^\d+(\.\d{1,3})?$/.test(price)) errors.push('السعر يجب أن يكون رقمًا مثل 5 أو 2.5');
    else data.price = price;
  }
  if (body.currency !== undefined) data.currency = cleanText(body.currency, 8) || 'JOD';
  if (!partial || body.durationType !== undefined) {
    const type = String(body.durationType || 'months');
    if (!DURATION_TYPES.includes(type)) errors.push('نوع المدة غير صالح');
    else data.durationType = type;
  }
  if (!partial || body.durationValue !== undefined) {
    const value = Number.parseInt(body.durationValue, 10);
    if (!Number.isInteger(value) || value < 1 || value > 1000) errors.push('المدة يجب أن تكون رقمًا صحيحًا موجبًا');
    else data.durationValue = value;
  }
  if (body.isActive !== undefined) data.isActive = bool(body.isActive);
  if (body.isFeatured !== undefined) data.isFeatured = bool(body.isFeatured);
  if (body.sortOrder !== undefined && Number.isInteger(Number(body.sortOrder))) {
    data.sortOrder = Number(body.sortOrder);
  }
  return { data, errors };
}

plansRouter.use(auth);

// الخطط المتاحة للمستخدم
plansRouter.get('/', async (_req, res) => {
  try {
    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    res.json(plans);
  } catch (error) {
    console.error('GET PLANS ERROR:', error);
    res.status(500).json({ message: 'تعذر تحميل خطط الاشتراك' });
  }
});

plansRouter.get('/admin/all', adminOnly, async (_req, res) => {
  try {
    const plans = await prisma.subscriptionPlan.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: { _count: { select: { paymentRequests: true } } },
    });
    res.json(plans.map(({ _count, ...p }) => ({ ...p, requestsCount: _count.paymentRequests })));
  } catch (error) {
    console.error('GET ADMIN PLANS ERROR:', error);
    res.status(500).json({ message: 'تعذر تحميل خطط الاشتراك' });
  }
});

plansRouter.post('/', adminOnly, async (req, res) => {
  try {
    const { data, errors } = planInput(req.body, false);
    if (errors.length) return res.status(400).json({ message: errors.join('، ') });
    if (data.sortOrder === undefined) {
      const last = await prisma.subscriptionPlan.findFirst({ orderBy: { sortOrder: 'desc' } });
      data.sortOrder = last ? last.sortOrder + 1 : 0;
    }
    const plan = await prisma.subscriptionPlan.create({ data });
    res.status(201).json(plan);
  } catch (error) {
    console.error('CREATE PLAN ERROR:', error);
    res.status(500).json({ message: 'تعذر إنشاء الخطة' });
  }
});

plansRouter.put('/:id', adminOnly, async (req, res) => {
  try {
    const { data, errors } = planInput(req.body, true);
    if (errors.length) return res.status(400).json({ message: errors.join('، ') });
    const plan = await prisma.subscriptionPlan.update({
      where: { id: Number(req.params.id) },
      data,
    });
    res.json(plan);
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ message: 'الخطة غير موجودة' });
    console.error('UPDATE PLAN ERROR:', error);
    res.status(500).json({ message: 'تعذر تعديل الخطة' });
  }
});

// الحذف: إذا ارتبطت الخطة بطلبات سابقة نوقفها فقط حفاظًا على السجلات
plansRouter.delete('/:id', adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const used = await prisma.paymentRequest.count({ where: { planId: id } });
    if (used > 0) {
      await prisma.subscriptionPlan.update({ where: { id }, data: { isActive: false } });
      return res.json({ ok: true, deactivated: true, message: 'الخطة مرتبطة بطلبات سابقة، تم إيقافها بدل حذفها' });
    }
    await prisma.subscriptionPlan.delete({ where: { id } });
    res.json({ ok: true });
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ message: 'الخطة غير موجودة' });
    console.error('DELETE PLAN ERROR:', error);
    res.status(500).json({ message: 'تعذر حذف الخطة' });
  }
});

// ---------------------------------------------------------------------------
// إعدادات الدفع عبر CliQ
// ---------------------------------------------------------------------------
const CLIQ_DEFAULT = {
  alias: 'Aseele1999',
  accountName: '',
  bankName: '',
  instructions: 'حوّل قيمة الباقة عبر CliQ إلى الاسم المستعار أدناه، ثم ارفع صورة إثبات التحويل.',
};

settingsRouter.use(auth);

settingsRouter.get('/cliq', async (_req, res) => {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: 'cliq' } });
    res.json({ ...CLIQ_DEFAULT, ...(row?.value || {}) });
  } catch (error) {
    console.error('GET CLIQ ERROR:', error);
    res.status(500).json({ message: 'تعذر تحميل بيانات الدفع' });
  }
});

settingsRouter.put('/cliq', adminOnly, async (req, res) => {
  try {
    const value = {
      alias: cleanText(req.body.alias, 80) || '',
      accountName: cleanText(req.body.accountName, 120) || '',
      bankName: cleanText(req.body.bankName, 120) || '',
      instructions: cleanText(req.body.instructions, 600) || '',
    };
    if (!value.alias) return res.status(400).json({ message: 'الاسم المستعار (CliQ Alias) مطلوب' });
    await prisma.appSetting.upsert({
      where: { key: 'cliq' },
      update: { value },
      create: { key: 'cliq', value },
    });
    res.json(value);
  } catch (error) {
    console.error('SAVE CLIQ ERROR:', error);
    res.status(500).json({ message: 'تعذر حفظ بيانات الدفع' });
  }
});

module.exports = { plansRouter, settingsRouter };
