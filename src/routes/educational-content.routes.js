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
