const express = require('express');

const prisma = require('../config/prisma');
const { auth, adminOnly } = require('../middleware/auth');
const { makeUpload, fileUrl } = require('../utils/upload');

const router = express.Router();

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
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'Name required' });
    }

    const imageUrl = fileUrl(req, 'images', req.file);

    const category = await prisma.category.create({
      data: {
        name,
        imageUrl,
      },
    });

    res.json(category);
  } catch (error) {
    console.error('CREATE CATEGORY ERROR:', error);
    res.status(500).json({ message: 'Failed to create category' });
  }
});

router.put('/:id', auth, adminOnly, makeUpload('images', 'image'), async (req, res) => {
  try {
    const data = {};

    if (req.body.name !== undefined) data.name = req.body.name;
    if (req.body.isActive !== undefined) {
      data.isActive = req.body.isActive === true || req.body.isActive === 'true';
    }
    if (req.file) data.imageUrl = fileUrl(req, 'images', req.file);

    const category = await prisma.category.update({
      where: { id: Number(req.params.id) },
      data,
    });

    res.json(category);
  } catch (error) {
    console.error('UPDATE CATEGORY ERROR:', error);
    res.status(500).json({ message: 'Failed to update category' });
  }
});

router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    await prisma.category.delete({
      where: { id: Number(req.params.id) },
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE CATEGORY ERROR:', error);
    res.status(500).json({ message: 'Failed to delete category' });
  }
});

module.exports = router;
