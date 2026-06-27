const express = require('express');
const multer = require('multer');

const prisma = require('../config/prisma');
const cloudinary = require('../config/cloudinary');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
}).any();

function uploadToCloudinary(file, folder, resourceType = 'auto') {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);

    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
      },
      (error, result) => {
        if (error) return reject(error);
        return resolve(result.secure_url);
      }
    );

    stream.end(file.buffer);
  });
}

function getFile(req, fieldName) {
  return (req.files || []).find((file) => file.fieldname === fieldName);
}

function parseVariants(body) {
  if (!body.variants) return [];

  try {
    const parsed = JSON.parse(body.variants);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
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

    if (!categoryId || !title || !speechText || !imageFile) {
      return res.status(400).json({
        message: 'categoryId, title, speechText, image required',
      });
    }

    const imageUrl = await uploadToCloudinary(
      imageFile,
      'uabber/items/images',
      'image'
    );

    const audioUrl = audioFile
      ? await uploadToCloudinary(audioFile, 'uabber/items/audio', 'auto')
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

    const variants = parseVariants(req.body);

    for (let i = 0; i < variants.length; i++) {
      const variant = variants[i];
      const variantImageFile = getFile(req, variant.imageField || `variantImage_${i}`);
      const variantAudioFile = getFile(req, variant.audioField || `variantAudio_${i}`);

      if (!variant.title || !variant.speechText || !variantImageFile) {
        continue;
      }

      const variantImageUrl = await uploadToCloudinary(
        variantImageFile,
        'uabber/items/variants/images',
        'image'
      );

      const variantAudioUrl = variantAudioFile
        ? await uploadToCloudinary(
            variantAudioFile,
            'uabber/items/variants/audio',
            'auto'
          )
        : null;

      await prisma.itemVariant.create({
        data: {
          itemId: item.id,
          title: variant.title,
          speechText: variant.speechText,
          imageUrl: variantImageUrl,
          audioUrl: variantAudioUrl,
        },
      });
    }

    const createdItem = await prisma.item.findUnique({
      where: { id: item.id },
      include: {
        variants: {
          orderBy: { id: 'asc' },
        },
      },
    });

    res.json(createdItem);
  } catch (error) {
    console.error('CREATE ITEM ERROR:', error);
    res.status(500).json({
      message: 'Failed to create item',
      error: error.message,
    });
  }
});

router.put('/:id', auth, adminOnly, upload, async (req, res) => {
  try {
    const data = {};
    const imageFile = getFile(req, 'image');
    const audioFile = getFile(req, 'audio');

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
      data.isActive = req.body.isActive === true || req.body.isActive === 'true';
    }

    if (imageFile) {
      data.imageUrl = await uploadToCloudinary(
        imageFile,
        'uabber/items/images',
        'image'
      );
    }

    if (audioFile) {
      data.audioUrl = await uploadToCloudinary(
        audioFile,
        'uabber/items/audio',
        'auto'
      );
    }

    const item = await prisma.item.update({
      where: {
        id: Number(req.params.id),
      },
      data,
      include: {
        variants: {
          orderBy: { id: 'asc' },
        },
      },
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
  try {
    await prisma.item.delete({
      where: {
        id: Number(req.params.id),
      },
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE ITEM ERROR:', error);
    res.status(500).json({ message: 'Failed to delete item' });
  }
});

module.exports = router;