const express = require('express');
const multer = require('multer');
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



router.get('/questions/unit/:unitId/item/:itemKey', async (req, res) => {
  try {
    const includeInactive = req.query.admin === 'true';
    const rows = await prisma.educationalQuestion.findMany({
      where: {
        unitId: req.params.unitId,
        itemKey: req.params.itemKey,
        ...(includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    res.json(rows);
  } catch (error) {
    console.error('GET EDUCATIONAL QUESTIONS ERROR:', error);
    res.status(500).json({ message: 'Failed to load educational questions' });
  }
});

router.post('/questions', auth, adminOnly, upload, async (req, res) => {
  try {
    const {
      id,
      unitId,
      itemKey,
      sourceKey,
      question,
      speechText,
      correctTitle,
      isActive,
      sortOrder,
      isOverride,
    } = req.body;

    let options = req.body.options;
    if (typeof options === 'string') {
      try {
        options = JSON.parse(options);
      } catch (_) {
        return res.status(400).json({ message: 'options must be valid JSON' });
      }
    }

    if (!id || !unitId || !itemKey || !question || !speechText || !correctTitle) {
      return res.status(400).json({
        message: 'id, unitId, itemKey, question, speechText and correctTitle are required',
      });
    }

    if (!Array.isArray(options) || options.length < 2) {
      return res.status(400).json({ message: 'At least two options are required' });
    }

    const cleanedOptions = [];
    for (let index = 0; index < options.length; index += 1) {
      const option = options[index] || {};
      const title = String(option.title || '').trim();
      if (!title) continue;

      const imageFile = fileFor(req, `optionImage_${index}`);
      let imageUrl = option.imageUrl ? String(option.imageUrl).trim() : null;
      if (imageFile) {
        imageUrl = await uploadToCloudinary(
          imageFile,
          `educational-questions/${String(unitId)}/${String(itemKey)}`
        );
      }

      cleanedOptions.push({
        title,
        emoji: String(option.emoji || '❓').trim() || '❓',
        imageUrl: imageUrl || null,
      });
    }

    if (cleanedOptions.length < 2) {
      return res.status(400).json({ message: 'At least two valid options are required' });
    }

    const normalizedCorrect = String(correctTitle).trim();
    if (!cleanedOptions.some((option) => option.title === normalizedCorrect)) {
      return res.status(400).json({ message: 'Correct answer must be one of the options' });
    }

    const data = {
      unitId: String(unitId),
      itemKey: String(itemKey),
      sourceKey: sourceKey ? String(sourceKey) : null,
      question: String(question).trim(),
      speechText: String(speechText).trim(),
      correctTitle: normalizedCorrect,
      options: cleanedOptions,
      isActive: boolValue(isActive, true),
      sortOrder: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0,
      isOverride: boolValue(isOverride),
      updatedById: req.user.id,
    };

    const row = await prisma.educationalQuestion.upsert({
      where: { id: String(id) },
      create: { id: String(id), ...data },
      update: data,
    });

    res.json(row);
  } catch (error) {
    console.error('UPSERT EDUCATIONAL QUESTION ERROR:', error);
    res.status(500).json({ message: 'Failed to save educational question', error: error.message });
  }
});

router.delete('/questions/:id', auth, adminOnly, async (req, res) => {
  try {
    await prisma.educationalQuestion.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ message: 'Question not found' });
    }
    console.error('DELETE EDUCATIONAL QUESTION ERROR:', error);
    res.status(500).json({ message: 'Failed to delete educational question' });
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
