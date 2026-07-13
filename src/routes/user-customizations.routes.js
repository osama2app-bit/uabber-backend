const express = require('express');
const multer = require('multer');
const prisma = require('../config/prisma');
const { auth } = require('../middleware/auth');
const { uploadToCloudinary } = require('../utils/upload');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }).any();
const fileFor = (req, name) => (req.files || []).find((f) => f.fieldname === name);

function parseData(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
}

router.use(auth);

router.get('/', async (req, res) => {
  try {
    const keys = typeof req.query.keys === 'string' && req.query.keys.trim()
      ? req.query.keys.split(',').map((x) => x.trim()).filter(Boolean)
      : null;
    const rows = await prisma.userContentCustomization.findMany({
      where: { userId: req.user.id, ...(keys ? { contentKey: { in: keys } } : {}) },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(rows);
  } catch (error) {
    console.error('GET USER CUSTOMIZATIONS ERROR:', error);
    res.status(500).json({ message: 'Failed to load customizations' });
  }
});

router.get('/:key', async (req, res) => {
  try {
    const row = await prisma.userContentCustomization.findUnique({
      where: { userId_contentKey: { userId: req.user.id, contentKey: req.params.key } },
    });
    if (!row) return res.status(404).json({ message: 'Customization not found' });
    res.json(row);
  } catch (error) {
    res.status(500).json({ message: 'Failed to load customization' });
  }
});

router.post('/', upload, async (req, res) => {
  try {
    const contentKey = (req.body.key || req.body.contentKey || '').toString().trim();
    const title = (req.body.title || '').toString().trim();
    const speechText = (req.body.speechText || '').toString().trim();
    if (!contentKey || !title || !speechText) {
      return res.status(400).json({ message: 'key, title and speechText are required' });
    }
    const imageFile = fileFor(req, 'image');
    const audioFile = fileFor(req, 'audio');
    const old = await prisma.userContentCustomization.findUnique({
      where: { userId_contentKey: { userId: req.user.id, contentKey } },
    });
    const removeImage = req.body.removeImage === true || req.body.removeImage === 'true';
    const removeAudio = req.body.removeAudio === true || req.body.removeAudio === 'true';
    const imageUrl = removeImage
      ? null
      : imageFile
        ? await uploadToCloudinary(imageFile, 'user-customizations')
        : (req.body.imageUrl || old?.imageUrl || null);
    const audioUrl = removeAudio
      ? null
      : audioFile
        ? await uploadToCloudinary(audioFile, 'audio')
        : (req.body.audioUrl || old?.audioUrl || null);
    const data = parseData(req.body.data);

    const row = await prisma.userContentCustomization.upsert({
      where: { userId_contentKey: { userId: req.user.id, contentKey } },
      create: { userId: req.user.id, contentKey, title, speechText, imageUrl, audioUrl, data },
      update: { title, speechText, imageUrl, audioUrl, data },
    });
    res.json(row);
  } catch (error) {
    console.error('SAVE USER CUSTOMIZATION ERROR:', error);
    res.status(500).json({ message: 'Failed to save customization', error: error.message });
  }
});

router.delete('/:key', async (req, res) => {
  try {
    await prisma.userContentCustomization.delete({
      where: { userId_contentKey: { userId: req.user.id, contentKey: req.params.key } },
    });
    res.json({ ok: true });
  } catch (error) {
    if (error.code === 'P2025') return res.json({ ok: true });
    res.status(500).json({ message: 'Failed to delete customization' });
  }
});

module.exports = router;
