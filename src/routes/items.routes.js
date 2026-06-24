const express = require('express');
const prisma = require('../config/prisma');
const { auth, adminOnly } = require('../middleware/auth');
const { fileUrl } = require('../utils/upload');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const router = express.Router();

function multiUpload() {
  ['images', 'audio'].forEach((folder) => {
    fs.mkdirSync(path.join(__dirname, '../../uploads', folder), {
      recursive: true,
    });
  });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(
        null,
        path.join(
          __dirname,
          '../../uploads',
          file.fieldname === 'audio' ? 'audio' : 'images'
        )
      );
    },
    filename: (_, file, cb) => {
      cb(
        null,
        `${Date.now()}-${Math.round(Math.random() * 1e9)}${path
          .extname(file.originalname)
          .toLowerCase()}`
      );
    },
  });

  return multer({
    storage,
    limits: {
      fileSize: 20 * 1024 * 1024,
    },
  }).fields([
    { name: 'image', maxCount: 1 },
    { name: 'audio', maxCount: 1 },
  ]);
}

router.get('/', async (req, res) => {
  const items = await prisma.item.findMany({
    where: { isActive: true },
    orderBy: { id: 'desc' },
  });

  res.json(items);
});

router.get('/category/:categoryId', async (req, res) => {
  const items = await prisma.item.findMany({
    where: {
      categoryId: Number(req.params.categoryId),
      isActive: true,
    },
    orderBy: { id: 'desc' },
  });

  res.json(items);
});

router.get('/admin/all', auth, adminOnly, async (req, res) => {
  const items = await prisma.item.findMany({
    orderBy: { id: 'desc' },
    include: { category: true },
  });

  res.json(items);
});

router.post('/', auth, adminOnly, multiUpload(), async (req, res) => {
  try {
    const { categoryId, title, speechText } = req.body;

    if (!categoryId || !title || !speechText || !req.files?.image?.[0]) {
      return res.status(400).json({
        message: 'categoryId, title, speechText, image required',
      });
    }

    const imageUrl = fileUrl(req, 'images', req.files.image[0]);

    const audioUrl = req.files?.audio?.[0]
      ? fileUrl(req, 'audio', req.files.audio[0])
      : null;

    const item = await prisma.item.create({
      data: {
        categoryId: Number(categoryId),
        title,
        speechText,
        imageUrl,
        audioUrl,
      },
    });

    res.json(item);
  } catch (error) {
    console.error('CREATE ITEM ERROR:', error);

    res.status(500).json({
      message: 'Failed to create item',
      error: error.message,
    });
  }
});

router.put('/:id', auth, adminOnly, multiUpload(), async (req, res) => {
  try {
    const data = {};

    if (req.body.categoryId !== undefined) {
      data.categoryId = Number(req.body.categoryId);
    }

    if (req.body.title !== undefined) {
      data.title = req.body.title;
    }

    if (req.body.speechText !== undefined) {
      data.speechText = req.body.speechText;
    }

    if (req.body.isActive !== undefined) {
      data.isActive = req.body.isActive === 'true';
    }

    if (req.files?.image?.[0]) {
      data.imageUrl = fileUrl(req, 'images', req.files.image[0]);
    }

    if (req.files?.audio?.[0]) {
      data.audioUrl = fileUrl(req, 'audio', req.files.audio[0]);
    }

    const item = await prisma.item.update({
      where: {
        id: Number(req.params.id),
      },
      data,
    });

    res.json(item);
  } catch (error) {
    console.error('UPDATE ITEM ERROR:', error);

    res.status(500).json({
      message: 'Failed to update item',
      error: error.message,
    });
  }
});

router.delete('/:id', auth, adminOnly, async (req, res) => {
  await prisma.item.delete({
    where: {
      id: Number(req.params.id),
    },
  });

  res.json({ ok: true });
});

module.exports = router;