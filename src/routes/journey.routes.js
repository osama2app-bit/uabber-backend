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
}).single('image');

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

router.get('/', async (req, res) => {
  try {
    const steps = await prisma.journeyStep.findMany({
      where: { isActive: true },
      orderBy: [
        { sortOrder: 'asc' },
        { id: 'asc' },
      ],
    });

    res.json(steps);
  } catch (error) {
    console.error('GET JOURNEY STEPS ERROR:', error);
    res.status(500).json({ message: 'Failed to load journey steps' });
  }
});

router.get('/admin/all', auth, adminOnly, async (req, res) => {
  try {
    const steps = await prisma.journeyStep.findMany({
      orderBy: [
        { sortOrder: 'asc' },
        { id: 'asc' },
      ],
    });

    res.json(steps);
  } catch (error) {
    console.error('GET ADMIN JOURNEY STEPS ERROR:', error);
    res.status(500).json({ message: 'Failed to load admin journey steps' });
  }
});

router.post('/', auth, adminOnly, upload, async (req, res) => {
  try {
    const { title, sortOrder } = req.body;
    const imageFile = req.file;

    if (!title || !imageFile) {
      return res.status(400).json({
        message: 'title and image required',
      });
    }

    const imageUrl = await uploadToCloudinary(
      imageFile,
      'uabber/journey/steps',
      'image'
    );

    const step = await prisma.journeyStep.create({
      data: {
        title,
        imageUrl,
        sortOrder: Number(sortOrder || 0),
      },
    });

    res.json(step);
  } catch (error) {
    console.error('CREATE JOURNEY STEP ERROR:', error);
    res.status(500).json({
      message: 'Failed to create journey step',
      error: error.message,
    });
  }
});

router.put('/:id', auth, adminOnly, upload, async (req, res) => {
  try {
    const data = {};
    const imageFile = req.file;

    if (req.body.title !== undefined) {
      data.title = req.body.title;
    }

    if (req.body.sortOrder !== undefined) {
      data.sortOrder = Number(req.body.sortOrder);
    }

    if (req.body.isActive !== undefined) {
      data.isActive =
        req.body.isActive === true || req.body.isActive === 'true';
    }

    if (imageFile) {
      data.imageUrl = await uploadToCloudinary(
        imageFile,
        'uabber/journey/steps',
        'image'
      );
    }

    const step = await prisma.journeyStep.update({
      where: {
        id: Number(req.params.id),
      },
      data,
    });

    res.json(step);
  } catch (error) {
    console.error('UPDATE JOURNEY STEP ERROR:', error);
    res.status(500).json({
      message: 'Failed to update journey step',
      error: error.message,
    });
  }
});

router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    await prisma.journeyStep.delete({
      where: {
        id: Number(req.params.id),
      },
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE JOURNEY STEP ERROR:', error);
    res.status(500).json({ message: 'Failed to delete journey step' });
  }
});

module.exports = router;
