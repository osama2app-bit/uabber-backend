const express = require('express');
const prisma = require('../config/prisma');
const { auth, adminOnly } = require('../middleware/auth');
const { makeUpload, fileUrl } = require('../utils/upload');

const router = express.Router();

async function resetCategoryIdSequence() {
  await prisma.$executeRawUnsafe(`
    SELECT setval(
      pg_get_serial_sequence('"Category"', 'id'),
      COALESCE((SELECT MAX(id) FROM "Category"), 1),
      true
    )
  `);
}

router.get('/', auth, async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      where: { isActive: true },
      orderBy: { id: 'asc' },
      include: {
        items: {
          where: { isActive: true },
          orderBy: { id: 'asc' },
        },
      },
    });

    res.json(categories);
  } catch (error) {
    console.error('GET CATEGORIES ERROR:', error);
    res.status(500).json({ message: 'Failed to load categories' });
  }
});

router.get('/admin/all', auth, adminOnly, async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: { id: 'desc' },
    });

    res.json(categories);
  } catch (error) {
    console.error('GET ADMIN CATEGORIES ERROR:', error);
    res.status(500).json({ message: 'Failed to load admin categories' });
  }
});

router.post('/', auth, adminOnly, makeUpload('images', 'image'), async (req, res) => {
  try {
    const name = (req.body.name || '').toString().trim();

    if (!name) {
      return res.status(400).json({ message: 'Name required' });
    }

    const imageUrl = fileUrl(req, 'images', req.file);

    try {
      const category = await prisma.category.create({
        data: {
          name,
          imageUrl,
          isActive: true,
        },
      });

      return res.json(category);
    } catch (error) {
      // If the PostgreSQL autoincrement sequence is behind existing IDs,
      // fix it once and retry safely.
      if (error.code === 'P2002' && error.meta?.target?.includes('id')) {
        await resetCategoryIdSequence();

        const category = await prisma.category.create({
          data: {
            name,
            imageUrl,
            isActive: true,
          },
        });

        return res.json(category);
      }

      throw error;
    }
  } catch (error) {
    console.error('CREATE CATEGORY ERROR:', error);
    res.status(500).json({
      message: 'Failed to create category',
      error: error.message,
    });
  }
});

router.put('/:id', auth, adminOnly, makeUpload('images', 'image'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: 'Invalid category id' });

    const data = {};

    if (req.body.name !== undefined) {
      data.name = req.body.name.toString().trim();
    }

    if (req.body.isActive !== undefined) {
      data.isActive = req.body.isActive === true || req.body.isActive === 'true';
    }

    if (req.file) {
      data.imageUrl = fileUrl(req, 'images', req.file);
    }

    const category = await prisma.category.update({
      where: { id },
      data,
    });

    res.json(category);
  } catch (error) {
    console.error('UPDATE CATEGORY ERROR:', error);
    res.status(500).json({
      message: 'Failed to update category',
      error: error.message,
    });
  }
});

router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: 'Invalid category id' });

    await prisma.category.delete({ where: { id } });

    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE CATEGORY ERROR:', error);
    res.status(500).json({
      message: 'Failed to delete category',
      error: error.message,
    });
  }
});

module.exports = router;
