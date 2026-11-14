// تسلسل الأحداث (Event Sequences)
//
// مجموعات مستقلة، لكل مجموعة: اسم + صورة غلاف + وصف اختياري + أحداث مرتبة.
// - المجموعات العامة (ownerId = null) يديرها الأدمن وتظهر لجميع المستخدمين.
// - المجموعات الخاصة (ownerId = المستخدم) يديرها صاحب الحساب فقط،
//   وتُحفظ في قاعدة البيانات فتُستعاد بعد حذف التطبيق أو من جهاز آخر.
const express = require('express');
const multer = require('multer');

const prisma = require('../config/prisma');
const { auth } = require('../middleware/auth');
const { uploadToCloudinary } = require('../utils/upload');

const router = express.Router();

const MAX_PERSONAL_GROUPS = 100;
const MAX_EVENTS_PER_GROUP = 60;
const MAX_TITLE = 120;
const MAX_DESCRIPTION = 600;

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && !file.mimetype.startsWith('image/') && file.mimetype !== 'application/octet-stream') {
      return cb(new Error('INVALID_IMAGE'));
    }
    return cb(null, true);
  },
});

const anyImage = (req, res, next) =>
  imageUpload.any()(req, res, (err) => {
    if (!err) return next();
    if (err.message === 'INVALID_IMAGE') {
      return res.status(400).json({ message: 'الملف المرفوع ليس صورة' });
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ message: 'حجم الصورة كبير جدًا (الحد 15MB)' });
    }
    return next(err);
  });

const fileFor = (req, ...names) =>
  (req.files || []).find((f) => names.includes(f.fieldname));

const eventsOrder = [{ sortOrder: 'asc' }, { id: 'asc' }];
const groupsOrder = [{ sortOrder: 'asc' }, { id: 'asc' }];

const isAdmin = (user) => user?.role === 'ADMIN';
const bool = (v) => v === true || v === 'true' || v === '1' || v === 1;

function cleanText(value, max) {
  if (value === undefined || value === null) return undefined;
  const text = value.toString().trim();
  return text.length > max ? text.slice(0, max) : text;
}

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function serializeGroup(group, user) {
  const events = (group.events || []).map((e) => ({
    id: e.id,
    groupId: e.groupId,
    title: e.title,
    description: e.description,
    imageUrl: e.imageUrl,
    audioUrl: e.audioUrl,
    sortOrder: e.sortOrder,
    isActive: e.isActive,
  }));

  return {
    id: group.id,
    title: group.title,
    description: group.description,
    coverImageUrl: group.coverImageUrl,
    sortOrder: group.sortOrder,
    isActive: group.isActive,
    clientId: group.clientId,
    isGlobal: group.ownerId === null,
    isOwn: user ? group.ownerId === user.id : false,
    canEdit: canEdit(user, group),
    eventsCount: events.length,
    events,
    updatedAt: group.updatedAt,
  };
}

function canEdit(user, group) {
  if (!user || !group) return false;
  if (group.ownerId === null) return isAdmin(user);
  return group.ownerId === user.id;
}

async function loadEditableGroup(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ message: 'معرّف غير صالح' });
    return null;
  }
  const group = await prisma.eventSequenceGroup.findUnique({ where: { id } });
  if (!group) {
    res.status(404).json({ message: 'المجموعة غير موجودة' });
    return null;
  }
  if (!canEdit(req.user, group)) {
    res.status(403).json({ message: 'لا تملك صلاحية تعديل هذه المجموعة' });
    return null;
  }
  return group;
}

async function fullGroup(id, includeInactiveEvents) {
  return prisma.eventSequenceGroup.findUnique({
    where: { id },
    include: {
      events: {
        where: includeInactiveEvents ? undefined : { isActive: true },
        orderBy: eventsOrder,
      },
    },
  });
}

router.use(auth);

// ---------------------------------------------------------------------------
// عرض المجموعات للمستخدم: العامة المفعّلة + الخاصة بحسابه
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const groups = await prisma.eventSequenceGroup.findMany({
      where: {
        OR: [
          { ownerId: null, isActive: true },
          { ownerId: req.user.id },
        ],
      },
      include: { events: { where: { isActive: true }, orderBy: eventsOrder } },
      orderBy: groupsOrder,
    });

    // العامة أولاً بترتيب الأدمن، ثم الخاصة بالمستخدم.
    const sorted = [
      ...groups.filter((g) => g.ownerId === null),
      ...groups.filter((g) => g.ownerId !== null),
    ];

    res.json(sorted.map((g) => serializeGroup(g, req.user)));
  } catch (error) {
    console.error('GET EVENT SEQUENCES ERROR:', error);
    res.status(500).json({ message: 'تعذر تحميل تسلسل الأحداث' });
  }
});

// كل المجموعات العامة للأدمن (بما فيها المخفية والأحداث المخفية)
router.get('/admin/all', async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ message: 'Admin only' });
  try {
    const groups = await prisma.eventSequenceGroup.findMany({
      where: { ownerId: null },
      include: { events: { orderBy: eventsOrder } },
      orderBy: groupsOrder,
    });
    res.json(groups.map((g) => serializeGroup(g, req.user)));
  } catch (error) {
    console.error('GET ADMIN EVENT SEQUENCES ERROR:', error);
    res.status(500).json({ message: 'تعذر تحميل تسلسل الأحداث' });
  }
});

// إعادة ترتيب المجموعات العامة (الأدمن)
router.put('/admin/reorder', async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ message: 'Admin only' });
  try {
    const ids = parseJson(req.body.ids, []).map(Number).filter(Number.isInteger);
    if (!ids.length) return res.status(400).json({ message: 'ids required' });

    await prisma.$transaction(
      ids.map((id, index) =>
        prisma.eventSequenceGroup.updateMany({
          where: { id, ownerId: null },
          data: { sortOrder: index },
        })
      )
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('REORDER EVENT SEQUENCES ERROR:', error);
    res.status(500).json({ message: 'تعذر حفظ الترتيب' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'معرّف غير صالح' });

    const group = await fullGroup(id, true);
    if (!group) return res.status(404).json({ message: 'المجموعة غير موجودة' });

    const editable = canEdit(req.user, group);
    const visible = editable || (group.ownerId === null && group.isActive);
    if (!visible) return res.status(404).json({ message: 'المجموعة غير موجودة' });

    if (!editable) group.events = group.events.filter((e) => e.isActive);
    res.json(serializeGroup(group, req.user));
  } catch (error) {
    console.error('GET EVENT SEQUENCE ERROR:', error);
    res.status(500).json({ message: 'تعذر تحميل المجموعة' });
  }
});

// رفع صورة منفصلة (تُستخدم عند نقل الرحلات القديمة المحفوظة على الجهاز)
router.post('/upload-image', anyImage, async (req, res) => {
  try {
    const file = fileFor(req, 'image');
    if (!file) return res.status(400).json({ message: 'image required' });
    const url = await uploadToCloudinary(file, 'event-sequences/events');
    res.json({ url });
  } catch (error) {
    console.error('UPLOAD EVENT IMAGE ERROR:', error);
    res.status(500).json({ message: 'تعذر رفع الصورة' });
  }
});

// ---------------------------------------------------------------------------
// إنشاء مجموعة
//  - الأدمن: عامة افتراضيًا، أو خاصة إذا أرسل scope=personal
//  - المستخدم: دائمًا خاصة بحسابه
//  - clientId يمنع التكرار: إذا وُجدت مجموعة بنفس المفتاح تُعاد كما هي
//  - events (اختياري): [{title, description, imageUrl}] تُنشأ في نفس العملية
// ---------------------------------------------------------------------------
router.post('/', anyImage, async (req, res) => {
  try {
    const title = cleanText(req.body.title, MAX_TITLE);
    if (!title) return res.status(400).json({ message: 'اسم المجموعة مطلوب' });

    const personal = !isAdmin(req.user) || req.body.scope === 'personal';
    const ownerId = personal ? req.user.id : null;
    const clientId = cleanText(req.body.clientId, 120) || null;

    if (ownerId !== null && clientId) {
      const existing = await prisma.eventSequenceGroup.findUnique({
        where: { ownerId_clientId: { ownerId, clientId } },
      });
      if (existing) {
        const group = await fullGroup(existing.id, true);
        return res.status(200).json({ ...serializeGroup(group, req.user), existed: true });
      }
    }

    if (ownerId !== null) {
      const count = await prisma.eventSequenceGroup.count({ where: { ownerId } });
      if (count >= MAX_PERSONAL_GROUPS) {
        return res.status(400).json({ message: `الحد الأقصى ${MAX_PERSONAL_GROUPS} مجموعة لكل حساب` });
      }
    }

    const rawEvents = parseJson(req.body.events, []);
    const events = (Array.isArray(rawEvents) ? rawEvents : [])
      .slice(0, MAX_EVENTS_PER_GROUP)
      .map((e, index) => ({
        title: cleanText(e?.title, MAX_TITLE) || `حدث ${index + 1}`,
        description: cleanText(e?.description, MAX_DESCRIPTION) || null,
        imageUrl: isHttpUrl(e?.imageUrl) ? e.imageUrl.trim() : null,
        sortOrder: index,
      }));

    const coverFile = fileFor(req, 'cover', 'image');
    let coverImageUrl = null;
    if (coverFile) {
      coverImageUrl = await uploadToCloudinary(coverFile, 'event-sequences/covers');
    } else if (isHttpUrl(req.body.coverImageUrl)) {
      coverImageUrl = req.body.coverImageUrl.trim();
    }

    let sortOrder = Number(req.body.sortOrder);
    if (!Number.isInteger(sortOrder)) {
      const last = await prisma.eventSequenceGroup.findFirst({
        where: { ownerId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      sortOrder = last ? last.sortOrder + 1 : 0;
    }

    const created = await prisma.eventSequenceGroup.create({
      data: {
        title,
        description: cleanText(req.body.description, MAX_DESCRIPTION) || null,
        coverImageUrl,
        sortOrder,
        isActive: req.body.isActive === undefined ? true : bool(req.body.isActive),
        ownerId,
        clientId: ownerId !== null ? clientId : null,
        events: events.length ? { create: events } : undefined,
      },
    });

    const group = await fullGroup(created.id, true);
    res.status(201).json(serializeGroup(group, req.user));
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ message: 'المجموعة موجودة مسبقًا' });
    }
    console.error('CREATE EVENT SEQUENCE ERROR:', error);
    res.status(500).json({ message: 'تعذر إنشاء المجموعة' });
  }
});

// تعديل المجموعة: الاسم، الوصف، صورة الغلاف، الإظهار/الإخفاء، الترتيب
router.put('/:id', anyImage, async (req, res) => {
  try {
    const group = await loadEditableGroup(req, res);
    if (!group) return;

    const data = {};
    if (req.body.title !== undefined) {
      const title = cleanText(req.body.title, MAX_TITLE);
      if (!title) return res.status(400).json({ message: 'اسم المجموعة مطلوب' });
      data.title = title;
    }
    if (req.body.description !== undefined) {
      data.description = cleanText(req.body.description, MAX_DESCRIPTION) || null;
    }
    if (req.body.isActive !== undefined) data.isActive = bool(req.body.isActive);
    if (req.body.sortOrder !== undefined && Number.isInteger(Number(req.body.sortOrder))) {
      data.sortOrder = Number(req.body.sortOrder);
    }

    const coverFile = fileFor(req, 'cover', 'image');
    if (coverFile) {
      data.coverImageUrl = await uploadToCloudinary(coverFile, 'event-sequences/covers');
    } else if (bool(req.body.removeCover)) {
      data.coverImageUrl = null;
    } else if (isHttpUrl(req.body.coverImageUrl)) {
      data.coverImageUrl = req.body.coverImageUrl.trim();
    }

    await prisma.eventSequenceGroup.update({ where: { id: group.id }, data });
    const updated = await fullGroup(group.id, true);
    res.json(serializeGroup(updated, req.user));
  } catch (error) {
    console.error('UPDATE EVENT SEQUENCE ERROR:', error);
    res.status(500).json({ message: 'تعذر تعديل المجموعة' });
  }
});

// حذف المجموعة مع أحداثها فقط (لا يؤثر على أي مجموعة أخرى)
router.delete('/:id', async (req, res) => {
  try {
    const group = await loadEditableGroup(req, res);
    if (!group) return;
    await prisma.eventSequenceGroup.delete({ where: { id: group.id } });
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE EVENT SEQUENCE ERROR:', error);
    res.status(500).json({ message: 'تعذر حذف المجموعة' });
  }
});

// ---------------------------------------------------------------------------
// الأحداث داخل المجموعة
// ---------------------------------------------------------------------------
router.post('/:id/events', anyImage, async (req, res) => {
  try {
    const group = await loadEditableGroup(req, res);
    if (!group) return;

    const title = cleanText(req.body.title, MAX_TITLE);
    if (!title) return res.status(400).json({ message: 'اسم الحدث مطلوب' });

    const count = await prisma.eventSequenceEvent.count({ where: { groupId: group.id } });
    if (count >= MAX_EVENTS_PER_GROUP) {
      return res.status(400).json({ message: `الحد الأقصى ${MAX_EVENTS_PER_GROUP} حدثًا لكل مجموعة` });
    }

    const imageFile = fileFor(req, 'image');
    let imageUrl = null;
    if (imageFile) {
      imageUrl = await uploadToCloudinary(imageFile, 'event-sequences/events');
    } else if (isHttpUrl(req.body.imageUrl)) {
      imageUrl = req.body.imageUrl.trim();
    }

    let sortOrder = Number(req.body.sortOrder);
    if (!Number.isInteger(sortOrder)) {
      const last = await prisma.eventSequenceEvent.findFirst({
        where: { groupId: group.id },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      sortOrder = last ? last.sortOrder + 1 : 0;
    }

    await prisma.eventSequenceEvent.create({
      data: {
        groupId: group.id,
        title,
        description: cleanText(req.body.description, MAX_DESCRIPTION) || null,
        imageUrl,
        sortOrder,
      },
    });
    await prisma.eventSequenceGroup.update({ where: { id: group.id }, data: { updatedAt: new Date() } });

    const updated = await fullGroup(group.id, true);
    res.status(201).json(serializeGroup(updated, req.user));
  } catch (error) {
    console.error('CREATE SEQUENCE EVENT ERROR:', error);
    res.status(500).json({ message: 'تعذر إضافة الحدث' });
  }
});

// إعادة ترتيب الأحداث: body.ids = [eventId, ...] بالترتيب الجديد
router.put('/:id/events/reorder', async (req, res) => {
  try {
    const group = await loadEditableGroup(req, res);
    if (!group) return;

    const ids = parseJson(req.body.ids, []).map(Number).filter(Number.isInteger);
    if (!ids.length) return res.status(400).json({ message: 'ids required' });

    await prisma.$transaction(
      ids.map((eventId, index) =>
        prisma.eventSequenceEvent.updateMany({
          where: { id: eventId, groupId: group.id },
          data: { sortOrder: index },
        })
      )
    );
    await prisma.eventSequenceGroup.update({ where: { id: group.id }, data: { updatedAt: new Date() } });

    const updated = await fullGroup(group.id, true);
    res.json(serializeGroup(updated, req.user));
  } catch (error) {
    console.error('REORDER SEQUENCE EVENTS ERROR:', error);
    res.status(500).json({ message: 'تعذر حفظ ترتيب الأحداث' });
  }
});

router.put('/:id/events/:eventId', anyImage, async (req, res) => {
  try {
    const group = await loadEditableGroup(req, res);
    if (!group) return;

    const eventId = Number(req.params.eventId);
    const event = await prisma.eventSequenceEvent.findFirst({
      where: { id: eventId, groupId: group.id },
    });
    if (!event) return res.status(404).json({ message: 'الحدث غير موجود' });

    const data = {};
    if (req.body.title !== undefined) {
      const title = cleanText(req.body.title, MAX_TITLE);
      if (!title) return res.status(400).json({ message: 'اسم الحدث مطلوب' });
      data.title = title;
    }
    if (req.body.description !== undefined) {
      data.description = cleanText(req.body.description, MAX_DESCRIPTION) || null;
    }
    if (req.body.isActive !== undefined) data.isActive = bool(req.body.isActive);

    const imageFile = fileFor(req, 'image');
    if (imageFile) {
      data.imageUrl = await uploadToCloudinary(imageFile, 'event-sequences/events');
    } else if (bool(req.body.removeImage)) {
      data.imageUrl = null;
    } else if (isHttpUrl(req.body.imageUrl)) {
      data.imageUrl = req.body.imageUrl.trim();
    }

    await prisma.eventSequenceEvent.update({ where: { id: event.id }, data });
    await prisma.eventSequenceGroup.update({ where: { id: group.id }, data: { updatedAt: new Date() } });

    const updated = await fullGroup(group.id, true);
    res.json(serializeGroup(updated, req.user));
  } catch (error) {
    console.error('UPDATE SEQUENCE EVENT ERROR:', error);
    res.status(500).json({ message: 'تعذر تعديل الحدث' });
  }
});

router.delete('/:id/events/:eventId', async (req, res) => {
  try {
    const group = await loadEditableGroup(req, res);
    if (!group) return;

    const eventId = Number(req.params.eventId);
    const result = await prisma.eventSequenceEvent.deleteMany({
      where: { id: eventId, groupId: group.id },
    });
    if (!result.count) return res.status(404).json({ message: 'الحدث غير موجود' });
    await prisma.eventSequenceGroup.update({ where: { id: group.id }, data: { updatedAt: new Date() } });

    const updated = await fullGroup(group.id, true);
    res.json(serializeGroup(updated, req.user));
  } catch (error) {
    console.error('DELETE SEQUENCE EVENT ERROR:', error);
    res.status(500).json({ message: 'تعذر حذف الحدث' });
  }
});

module.exports = router;
