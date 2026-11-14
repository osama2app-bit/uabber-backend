// تقدّم الطفل في البرنامج التعليمي: يُحفظ في الحساب ويُدمج بين الأجهزة.
// الدمج آمن: اتحاد العناصر المنجزة والاختبارات الناجحة، وأكبر عدد نجوم.
const express = require('express');
const prisma = require('../config/prisma');
const { auth } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

const MAX_UNITS = 500;
const MAX_ITEMS_PER_UNIT = 1000;

function normalize(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const items = {};
  const rawItems = data.items && typeof data.items === 'object' ? data.items : {};
  for (const unitId of Object.keys(rawItems).slice(0, MAX_UNITS)) {
    const list = Array.isArray(rawItems[unitId]) ? rawItems[unitId] : [];
    items[String(unitId).slice(0, 120)] = [
      ...new Set(list.map((x) => String(x).slice(0, 200))),
    ].slice(0, MAX_ITEMS_PER_UNIT);
  }
  const quiz = Array.isArray(data.quiz)
    ? [...new Set(data.quiz.map((x) => String(x).slice(0, 120)))].slice(0, MAX_UNITS)
    : [];
  const stars = Math.max(0, Math.min(1000000, Number.parseInt(data.stars, 10) || 0));
  const lastActive = typeof data.lastActive === 'string' ? data.lastActive.slice(0, 40) : null;
  return { items, quiz, stars, lastActive };
}

function merge(a, b) {
  const items = { ...a.items };
  for (const [unit, list] of Object.entries(b.items)) {
    items[unit] = [...new Set([...(items[unit] || []), ...list])];
  }
  return {
    items,
    quiz: [...new Set([...a.quiz, ...b.quiz])],
    stars: Math.max(a.stars, b.stars),
    lastActive: [a.lastActive, b.lastActive].filter(Boolean).sort().pop() || null,
  };
}

router.get('/', async (req, res) => {
  try {
    const row = await prisma.userProgress.findUnique({ where: { userId: req.user.id } });
    res.json(normalize(row?.data));
  } catch (error) {
    console.error('GET PROGRESS ERROR:', error);
    res.status(500).json({ message: 'تعذر تحميل التقدّم' });
  }
});

// replace=true يستبدل التقدّم بالكامل (لزر "إعادة ضبط التقدّم")، وإلا يدمج.
router.put('/', async (req, res) => {
  try {
    const incoming = normalize(req.body);
    const replace = req.body.replace === true || req.body.replace === 'true';
    const row = await prisma.userProgress.findUnique({ where: { userId: req.user.id } });
    const data = replace || !row ? incoming : merge(normalize(row.data), incoming);

    await prisma.userProgress.upsert({
      where: { userId: req.user.id },
      update: { data },
      create: { userId: req.user.id, data },
    });
    res.json(data);
  } catch (error) {
    console.error('SAVE PROGRESS ERROR:', error);
    res.status(500).json({ message: 'تعذر حفظ التقدّم' });
  }
});

module.exports = router;
