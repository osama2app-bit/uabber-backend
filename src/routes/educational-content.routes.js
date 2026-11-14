const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');
const { auth, adminOnly } = require('../middleware/auth');
const { uploadToCloudinary } = require('../utils/upload');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }).any();
const fileFor = (req, name) => (req.files || []).find((f) => f.fieldname === name);
const boolValue = (value, fallback = false) => value == null ? fallback : value === true || value === 'true';

router.get('/', async (req, res) => {
  try {
    const rows = await prisma.educationalContentOverride.findMany({ orderBy: [{ unitId: 'asc' }, { createdAt: 'asc' }] });
    res.json(rows);
  } catch (error) {
    console.error('GET EDUCATIONAL CONTENT ERROR:', error);
    res.status(500).json({ message: 'Failed to load educational content' });
  }
});

router.get('/unit/:unitId', async (req, res) => {
  try {
    const rows = await prisma.educationalContentOverride.findMany({
      where: { unitId: req.params.unitId },
      orderBy: { createdAt: 'asc' },
    });
    res.json(rows);
  } catch (error) {
    console.error('GET UNIT EDUCATIONAL CONTENT ERROR:', error);
    res.status(500).json({ message: 'Failed to load unit content' });
  }
});



// المستخدم (إن أرسل التوكن) يرى أيضًا الأسئلة التي أضافها لحسابه.
async function optionalUser(req) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return null;
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return await prisma.user.findUnique({ where: { id: payload.id } });
  } catch (_) {
    return null;
  }
}

router.get('/questions/unit/:unitId/item/:itemKey', async (req, res) => {
  try {
    const user = await optionalUser(req);
    const includeInactive = req.query.admin === 'true' && user?.role === 'ADMIN';
    const rows = await prisma.educationalQuestion.findMany({
      where: {
        unitId: req.params.unitId,
        itemKey: req.params.itemKey,
        OR: [{ ownerId: null }, ...(user ? [{ ownerId: user.id }] : [])],
        ...(includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    res.json(rows.map((r) => ({ ...r, isMine: Boolean(user && r.ownerId === user.id) })));
  } catch (error) {
    console.error('GET EDUCATIONAL QUESTIONS ERROR:', error);
    res.status(500).json({ message: 'تعذر تحميل الأسئلة' });
  }
});

const QUESTION_TYPES = ['choice', 'true_false'];
const TRUE_FALSE_OPTIONS = [
  { title: 'صح', emoji: '✅', imageUrl: null },
  { title: 'خطأ', emoji: '❌', imageUrl: null },
];

// تجهيز بيانات السؤال والتحقق منها (مشترك بين الأدمن والمستخدم)
async function buildQuestionData(req, ownerId) {
  const {
    unitId, itemKey, sourceKey, question, speechText,
    correctTitle, isActive, sortOrder, isOverride,
  } = req.body;
  const type = QUESTION_TYPES.includes(req.body.type) ? req.body.type : 'choice';

  if (!unitId || !itemKey || !question) {
    return { error: 'اكتب نص السؤال' };
  }

  const questionImage = fileFor(req, 'questionImage');
  let imageUrl = req.body.imageUrl ? String(req.body.imageUrl).trim() : null;
  if (req.body.removeImage === 'true' || req.body.removeImage === true) imageUrl = null;
  if (questionImage) {
    imageUrl = await uploadToCloudinary(
      questionImage,
      `educational-questions/${String(unitId)}/${String(itemKey)}`
    );
  }

  let cleanedOptions = [];
  let normalizedCorrect = String(correctTitle || '').trim();

  if (type === 'true_false') {
    cleanedOptions = TRUE_FALSE_OPTIONS;
    if (!['صح', 'خطأ'].includes(normalizedCorrect)) {
      return { error: 'اختر الإجابة الصحيحة: صح أو خطأ' };
    }
  } else {
    let options = req.body.options;
    if (typeof options === 'string') {
      try {
        options = JSON.parse(options);
      } catch (_) {
        return { error: 'خيارات غير صالحة' };
      }
    }
    if (!Array.isArray(options)) options = [];

    for (let index = 0; index < Math.min(options.length, 6); index += 1) {
      const option = options[index] || {};
      const title = String(option.title || '').trim();
      if (!title) continue;
      const imageFile = fileFor(req, `optionImage_${index}`);
      let optionImageUrl = option.imageUrl ? String(option.imageUrl).trim() : null;
      if (imageFile) {
        optionImageUrl = await uploadToCloudinary(
          imageFile,
          `educational-questions/${String(unitId)}/${String(itemKey)}`
        );
      }
      cleanedOptions.push({
        title,
        emoji: String(option.emoji || '').trim(),
        imageUrl: optionImageUrl || null,
      });
    }

    if (cleanedOptions.length < 2) {
      return { error: 'أضف خيارين على الأقل' };
    }
    if (!cleanedOptions.some((option) => option.title === normalizedCorrect)) {
      return { error: 'الإجابة الصحيحة يجب أن تكون أحد الخيارات' };
    }
  }

  return {
    data: {
      unitId: String(unitId),
      itemKey: String(itemKey),
      sourceKey: sourceKey ? String(sourceKey) : null,
      question: String(question).trim().slice(0, 300),
      speechText: String(speechText || question).trim().slice(0, 300),
      correctTitle: normalizedCorrect,
      options: cleanedOptions,
      type,
      imageUrl,
      ownerId,
      isActive: boolValue(isActive, true),
      sortOrder: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0,
      isOverride: ownerId ? false : boolValue(isOverride),
      updatedById: req.user.id,
    },
  };
}

router.post('/questions', auth, adminOnly, upload, async (req, res) => {
  try {
    if (!req.body.id) return res.status(400).json({ message: 'id required' });
    const { data, error } = await buildQuestionData(req, null);
    if (error) return res.status(400).json({ message: error });

    const row = await prisma.educationalQuestion.upsert({
      where: { id: String(req.body.id) },
      create: { id: String(req.body.id), ...data },
      update: data,
    });
    res.json(row);
  } catch (error) {
    console.error('UPSERT EDUCATIONAL QUESTION ERROR:', error);
    res.status(500).json({ message: 'تعذر حفظ السؤال' });
  }
});

// المستخدم العادي يضيف/يعدّل أسئلة خاصة بحسابه فقط
router.post('/questions/mine', auth, upload, async (req, res) => {
  try {
    const id = String(req.body.id || '').trim();
    if (!id) return res.status(400).json({ message: 'id required' });

    const existing = await prisma.educationalQuestion.findUnique({ where: { id } });
    if (existing && existing.ownerId !== req.user.id) {
      return res.status(403).json({ message: 'لا تملك صلاحية تعديل هذا السؤال' });
    }
    if (!existing) {
      const count = await prisma.educationalQuestion.count({ where: { ownerId: req.user.id } });
      if (count >= 500) return res.status(400).json({ message: 'وصلت للحد الأقصى من الأسئلة' });
    }

    const { data, error } = await buildQuestionData(req, req.user.id);
    if (error) return res.status(400).json({ message: error });

    const row = await prisma.educationalQuestion.upsert({
      where: { id },
      create: { id, ...data },
      update: data,
    });
    res.json({ ...row, isMine: true });
  } catch (error) {
    console.error('UPSERT MY QUESTION ERROR:', error);
    res.status(500).json({ message: 'تعذر حفظ السؤال' });
  }
});

router.delete('/questions/mine/:id', auth, async (req, res) => {
  try {
    const result = await prisma.educationalQuestion.deleteMany({
      where: { id: req.params.id, ownerId: req.user.id },
    });
    if (!result.count) return res.status(404).json({ message: 'السؤال غير موجود' });
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE MY QUESTION ERROR:', error);
    res.status(500).json({ message: 'تعذر حذف السؤال' });
  }
});

router.delete('/questions/:id', auth, adminOnly, async (req, res) => {
  try {
    await prisma.educationalQuestion.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ message: 'السؤال غير موجود' });
    }
    console.error('DELETE EDUCATIONAL QUESTION ERROR:', error);
    res.status(500).json({ message: 'تعذر حذف السؤال' });
  }
});

router.post('/', auth, adminOnly, upload, async (req, res) => {
  try {
    const { id, unitId, title, speechText, targetKey } = req.body;
    if (!id || !unitId || !title || !speechText) {
      return res.status(400).json({ message: 'id, unitId, title and speechText are required' });
    }
    const imageFile = fileFor(req, 'image');
    const audioFile = fileFor(req, 'audio');
    const imageUrl = imageFile ? await uploadToCloudinary(imageFile, 'educational-content') : (req.body.imageUrl || null);
    const audioUrl = audioFile ? await uploadToCloudinary(audioFile, 'audio') : (req.body.audioUrl || null);

    const row = await prisma.educationalContentOverride.upsert({
      where: { id: id.toString() },
      create: {
        id: id.toString(), unitId: unitId.toString(), title: title.toString().trim(),
        speechText: speechText.toString().trim(), imageUrl, audioUrl,
        isOverride: boolValue(req.body.isOverride), targetKey: targetKey || null,
        updatedById: req.user.id,
      },
      update: {
        unitId: unitId.toString(), title: title.toString().trim(), speechText: speechText.toString().trim(),
        imageUrl, audioUrl, isOverride: boolValue(req.body.isOverride), targetKey: targetKey || null,
        updatedById: req.user.id,
      },
    });
    res.json(row);
  } catch (error) {
    console.error('UPSERT EDUCATIONAL CONTENT ERROR:', error);
    res.status(500).json({ message: 'Failed to save educational content', error: error.message });
  }
});

router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    await prisma.educationalContentOverride.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ message: 'Content not found' });
    console.error('DELETE EDUCATIONAL CONTENT ERROR:', error);
    res.status(500).json({ message: 'Failed to delete educational content' });
  }
});

module.exports = router;
