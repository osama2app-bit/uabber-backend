// القصص التعليمية وتسجيلاتها الصوتية.
//   المستخدم: GET /api/stories            (المنشورة فقط، مرتبة)
//   الأدمن:   GET /api/stories/admin/all  (كل الحالات)
//             POST /api/stories/admin      (multipart: image, audio)
//             PUT  /api/stories/admin/:id  (multipart: image, audio + removeImage/removeAudio)
//             PUT  /api/stories/admin/reorder { ids: [...] }
//             DELETE /api/stories/admin/:id/audio
//             DELETE /api/stories/admin/:id
const express = require('express');
const prisma = require('../config/prisma');
const { auth, adminOnly } = require('../middleware/auth');
const { makeMediaUpload, fileUrl } = require('../utils/upload');

const router = express.Router();
const STATUSES = new Set(['DRAFT', 'PUBLISHED', 'HIDDEN', 'ARCHIVED']);
const media = makeMediaUpload({ image: 'image', audio: 'audio' });

const clean = (v, max) => {
  const s = String(v ?? '').trim();
  return s.length > max ? s.slice(0, max) : s;
};
const toInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const isTrue = (v) => v === true || v === 'true' || v === '1';

const PUBLIC_FIELDS = {
  id: true, title: true, text: true, word: true, emoji: true, imageUrl: true,
  audioUrl: true, audioDurationSec: true, sortOrder: true, legacyKey: true, updatedAt: true,
};

/** يقرأ ويتحقق من حقول القصة. partial = للتعديل. */
function readStory(body, partial) {
  const data = {};
  const errors = [];
  if (!partial || body.title !== undefined) {
    data.title = clean(body.title, 120);
    if (data.title.length < 2) errors.push('عنوان القصة مطلوب');
  }
  if (!partial || body.text !== undefined) {
    data.text = clean(body.text, 5000);
    if (data.text.length < 5) errors.push('نص القصة مطلوب');
  }
  if (body.word !== undefined) data.word = clean(body.word, 80) || null;
  if (body.emoji !== undefined) data.emoji = clean(body.emoji, 16) || null;
  if (body.sortOrder !== undefined) {
    const n = Number(body.sortOrder);
    if (!Number.isInteger(n) || n < 0 || n > 100000) errors.push('الترتيب غير صالح');
    else data.sortOrder = n;
  }
  if (body.status !== undefined) {
    const status = String(body.status).toUpperCase();
    if (!STATUSES.has(status)) errors.push('حالة القصة غير صالحة');
    else data.status = status;
  }
  if (body.audioDurationSec !== undefined && body.audioDurationSec !== '') {
    const n = Math.round(Number(body.audioDurationSec));
    if (!Number.isFinite(n) || n < 0 || n > 3600) errors.push('مدة التسجيل غير صالحة');
    else data.audioDurationSec = n;
  }
  return { data, errors };
}

// ---------------------------------------------------------------------------
// المستخدم
// ---------------------------------------------------------------------------

router.get('/', auth, async (_req, res, next) => {
  try {
    const stories = await prisma.story.findMany({
      where: { status: 'PUBLISHED' },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: PUBLIC_FIELDS,
    });
    return res.json(stories);
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// الأدمن
// ---------------------------------------------------------------------------

router.get('/admin/all', auth, adminOnly, async (_req, res, next) => {
  try {
    const stories = await prisma.story.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
    return res.json(stories);
  } catch (error) {
    return next(error);
  }
});

router.post('/admin', auth, adminOnly, media, async (req, res, next) => {
  try {
    const { data, errors } = readStory(req.body, false);
    if (errors.length) return res.status(400).json({ message: errors.join('، ') });
    const image = req.files?.image?.[0];
    const audio = req.files?.audio?.[0];
    if (image) data.imageUrl = await fileUrl(req, 'stories', image);
    if (audio) data.audioUrl = await fileUrl(req, 'stories-audio', audio);
    if (data.sortOrder === undefined) {
      const last = await prisma.story.aggregate({ _max: { sortOrder: true } });
      data.sortOrder = (last._max.sortOrder || 0) + 1;
    }
    data.status = data.status || 'DRAFT';
    if (data.status === 'PUBLISHED') data.publishedAt = new Date();
    const story = await prisma.story.create({ data });
    return res.status(201).json(story);
  } catch (error) {
    return next(error);
  }
});

router.put('/admin/reorder', auth, adminOnly, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(toInt) : [];
    if (ids.length === 0 || ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      return res.status(400).json({ message: 'قائمة الترتيب غير صالحة' });
    }
    await prisma.$transaction(ids.map((id, index) => prisma.story.update({ where: { id }, data: { sortOrder: index + 1 } })));
    return res.json({ ok: true });
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ message: 'قصة غير موجودة في القائمة' });
    return next(error);
  }
});

router.put('/admin/:id', auth, adminOnly, media, async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    const current = id ? await prisma.story.findUnique({ where: { id } }) : null;
    if (!current) return res.status(404).json({ message: 'القصة غير موجودة' });

    const { data, errors } = readStory(req.body, true);
    if (errors.length) return res.status(400).json({ message: errors.join('، ') });
    const image = req.files?.image?.[0];
    const audio = req.files?.audio?.[0];
    if (image) data.imageUrl = await fileUrl(req, 'stories', image);
    else if (isTrue(req.body.removeImage)) data.imageUrl = null;
    if (audio) data.audioUrl = await fileUrl(req, 'stories-audio', audio);
    else if (isTrue(req.body.removeAudio)) {
      data.audioUrl = null;
      data.audioDurationSec = null;
    }
    if (data.status === 'PUBLISHED' && current.status !== 'PUBLISHED') data.publishedAt = new Date();

    const story = await prisma.story.update({ where: { id }, data });
    return res.json(story);
  } catch (error) {
    return next(error);
  }
});

router.delete('/admin/:id/audio', auth, adminOnly, async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    const r = await prisma.story.updateMany({ where: { id }, data: { audioUrl: null, audioDurationSec: null } });
    if (r.count === 0) return res.status(404).json({ message: 'القصة غير موجودة' });
    return res.json(await prisma.story.findUnique({ where: { id } }));
  } catch (error) {
    return next(error);
  }
});

router.delete('/admin/:id', auth, adminOnly, async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    const r = await prisma.story.deleteMany({ where: { id } });
    if (r.count === 0) return res.status(404).json({ message: 'القصة غير موجودة' });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * مرة واحدة: نص القصة وكلمتها من تعديلات الأدمن القديمة (محفوظة كـ JSON داخل
 * EducationalContentOverride.speechText). الأخطاء لا توقف السيرفر.
 */
async function importLegacyStoryText() {
  const key = 'stories_legacy_text_import_v1';
  const done = await prisma.appSetting.findUnique({ where: { key } });
  if (done) return 0;
  const overrides = await prisma.educationalContentOverride.findMany({
    where: { unitId: 'stories', targetKey: { startsWith: 'story_' } },
  });
  let updated = 0;
  for (const o of overrides) {
    try {
      const parsed = JSON.parse(o.speechText);
      const text = clean(parsed.text, 5000);
      const word = clean(parsed.word, 80);
      if (!text) continue;
      const r = await prisma.story.updateMany({
        where: { legacyKey: o.targetKey.slice('story_'.length) },
        data: { text, ...(word ? { word } : {}) },
      });
      updated += r.count;
    } catch (_) {
      // نص قديم غير منظّم: نبقي النص الأصلي
    }
  }
  await prisma.appSetting.create({ data: { key, value: { updated, at: new Date().toISOString() } } });
  return updated;
}

module.exports = router;
module.exports.importLegacyStoryText = importLegacyStoryText;
