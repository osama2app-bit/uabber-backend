const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const prisma = require('../config/prisma');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();

const uploadDir = path.join(__dirname, '../../uploads/items');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
}).any();

function fileUrl(req, file) {
  if (!file) return null;
  const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}/uploads/items/${file.filename}`;
}

function getFile(req, fieldName) {
  return (req.files || []).find((file) => file.fieldname === fieldName);
}

function parseVariants(body) {
  if (body.variants === undefined || body.variants === null || body.variants === '') return [];
  try {
    const parsed = JSON.parse(body.variants);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

async function buildVariantCreateData(req, itemId, variants) {
  const data = [];

  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    const title = (variant.title || '').toString().trim();
    const speechText = (variant.speechText || '').toString().trim();
    if (!title || !speechText) continue;

    const imageFile = getFile(req, variant.imageField || `variantImage_${i}`);
    const audioFile = getFile(req, variant.audioField || `variantAudio_${i}`);

    const imageUrl = imageFile ? fileUrl(req, imageFile) : variant.currentImageUrl;
    const audioUrl = audioFile ? fileUrl(req, audioFile) : variant.currentAudioUrl || null;

    if (!imageUrl) continue;

    data.push({
      itemId,
      title,
      speechText,
      imageUrl,
      audioUrl,
      isActive: variant.isActive === false || variant.isActive === 'false' ? false : true,
    });
  }

  return data;
}

router.get('/', async (req, res) => {
  try {
    const items = await prisma.item.findMany({
      where: { isActive: true },
      orderBy: { id: 'desc' },
      include: {
        variants: {
          where: { isActive: true },
          orderBy: { id: 'asc' },
        },
      },
    });

    res.json(items);
  } catch (error) {
    console.error('GET ITEMS ERROR:', error);
    res.status(500).json({ message: 'Failed to load items' });
  }
});

router.get('/category/:categoryId', async (req, res) => {
  try {
    const items = await prisma.item.findMany({
      where: {
        categoryId: Number(req.params.categoryId),
        isActive: true,
      },
      orderBy: { id: 'desc' },
      include: {
        variants: {
          where: { isActive: true },
          orderBy: { id: 'asc' },
        },
      },
    });

    res.json(items);
  } catch (error) {
    console.error('GET CATEGORY ITEMS ERROR:', error);
    res.status(500).json({ message: 'Failed to load category items' });
  }
});

router.get('/admin/all', auth, adminOnly, async (req, res) => {
  try {
    const items = await prisma.item.findMany({
      orderBy: { id: 'desc' },
      include: {
        category: true,
        variants: {
          orderBy: { id: 'asc' },
        },
      },
    });

    res.json(items);
  } catch (error) {
    console.error('GET ADMIN ITEMS ERROR:', error);
    res.status(500).json({ message: 'Failed to load admin items' });
  }
});

router.post('/', auth, adminOnly, upload, async (req, res) => {
  try {
    const { categoryId, title, speechText } = req.body;
    const imageFile = getFile(req, 'image');
    const audioFile = getFile(req, 'audio');

    const parsedCategoryId = Number(categoryId);
    if (!parsedCategoryId || !title || !speechText || !imageFile) {
      return res.status(400).json({
        message: 'categoryId, title, speechText, image required',
      });
    }

    const category = await prisma.category.findUnique({ where: { id: parsedCategoryId } });
    if (!category) {
      return res.status(400).json({ message: 'Category not found' });
    }

    const item = await prisma.item.create({
      data: {
        categoryId: parsedCategoryId,
        title: title.toString().trim(),
        speechText: speechText.toString().trim(),
        imageUrl: fileUrl(req, imageFile),
        audioUrl: audioFile ? fileUrl(req, audioFile) : null,
      },
    });

    const variants = parseVariants(req.body);
    const variantData = await buildVariantCreateData(req, item.id, variants);
    if (variantData.length > 0) {
      await prisma.itemVariant.createMany({ data: variantData });
    }

    const createdItem = await prisma.item.findUnique({
      where: { id: item.id },
      include: { variants: { orderBy: { id: 'asc' } } },
    });

    res.json(createdItem);
  } catch (error) {
    console.error('CREATE ITEM ERROR:', error);
    res.status(500).json({ message: 'Failed to create item', error: error.message });
  }
});

router.put('/:id', auth, adminOnly, upload, async (req, res) => {
  try {
    const itemId = Number(req.params.id);
    if (!itemId) return res.status(400).json({ message: 'Invalid item id' });

    const data = {};
    const imageFile = getFile(req, 'image');
    const audioFile = getFile(req, 'audio');

    if (req.body.categoryId !== undefined) {
      const parsedCategoryId = Number(req.body.categoryId);
      const category = await prisma.category.findUnique({ where: { id: parsedCategoryId } });
      if (!category) return res.status(400).json({ message: 'Category not found' });
      data.categoryId = parsedCategoryId;
    }

    if (req.body.title !== undefined) data.title = req.body.title.toString().trim();
    if (req.body.speechText !== undefined) data.speechText = req.body.speechText.toString().trim();
    if (req.body.isActive !== undefined) data.isActive = req.body.isActive === true || req.body.isActive === 'true';
    if (imageFile) data.imageUrl = fileUrl(req, imageFile);
    if (audioFile) data.audioUrl = fileUrl(req, audioFile);

    await prisma.item.update({ where: { id: itemId }, data });

    if (req.body.variants !== undefined) {
      const variants = parseVariants(req.body);
      await prisma.itemVariant.deleteMany({ where: { itemId } });
      const variantData = await buildVariantCreateData(req, itemId, variants);
      if (variantData.length > 0) {
        await prisma.itemVariant.createMany({ data: variantData });
      }
    }

    const item = await prisma.item.findUnique({
      where: { id: itemId },
      include: { variants: { orderBy: { id: 'asc' } } },
    });

    res.json(item);
  } catch (error) {
    console.error('UPDATE ITEM ERROR:', error);
    res.status(500).json({ message: 'Failed to update item', error: error.message });
  }
});

router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    await prisma.item.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE ITEM ERROR:', error);
    res.status(500).json({ message: 'Failed to delete item' });
  }
});

module.exports = router;
