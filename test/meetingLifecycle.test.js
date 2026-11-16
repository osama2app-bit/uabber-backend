// اختبارات وحدة لدورة حياة الاجتماعات (قاعدة بيانات وGoogle وهميتان).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMeetingLifecycle, CLAIM_TTL_MS } = require('../src/services/meetingLifecycle');

// --- Prisma وهمي بسيط (updateMany ذري لأنه متزامن داخل حلقة الأحداث) ---
function matches(row, where) {
  return Object.entries(where).every(([k, v]) => (v === null ? row[k] == null : row[k] === v));
}
function fakePrisma(consultations) {
  const rows = new Map(consultations.map((c) => [c.id, { ...c }]));
  const pending = new Map();
  let pid = 0;
  const db = {
    rows,
    pending,
    failPendingWrites: false,
    consultation: {
      findUnique: async ({ where }) => {
        const r = rows.get(where.id);
        return r ? { ...r } : null;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const r of rows.values()) {
          if (matches(r, where)) {
            Object.assign(r, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    pendingMeetingDeletion: {
      upsert: async ({ where, create, update }) => {
        if (db.failPendingWrites) throw new Error('db down');
        const existing = pending.get(where.eventId);
        if (existing) {
          existing.attempts += update.attempts.increment;
          existing.lastError = update.lastError;
          return existing;
        }
        const row = { id: ++pid, createdAt: new Date(), ...create };
        pending.set(create.eventId, row);
        return row;
      },
      findMany: async () => [...pending.values()],
      count: async () => pending.size,
      delete: async ({ where }) => {
        for (const [k, v] of pending) if (v.id === where.id) pending.delete(k);
      },
      update: async ({ where, data }) => {
        for (const v of pending.values()) {
          if (v.id === where.id) {
            v.attempts += data.attempts.increment;
            v.lastError = data.lastError;
          }
        }
      },
    },
  };
  return db;
}

// --- Google وهمي ---
function fakeMeet({ createDelay = 0 } = {}) {
  let seq = 0;
  const m = {
    configured: true,
    events: new Map(), // eventId -> {deleted}
    created: [],
    deleted: [],
    createError: null,
    deleteStatus: null, // null = نجاح، رقم = فشل بهذا الرمز
    isMeetConfigured: () => m.configured,
    newEventId: (id) => `uabber${id}c${++seq}`,
    createMeeting: async ({ eventId }) => {
      if (createDelay) await new Promise((r) => setTimeout(r, createDelay));
      if (m.createError) throw m.createError;
      m.events.set(eventId, { deleted: false });
      m.created.push(eventId);
      return { meetingUrl: `https://meet.google.com/aaa-bbbb-${String(seq).padStart(3, 'c')}`, eventId };
    },
    deleteMeeting: async (eventId) => {
      m.deleted.push(eventId);
      if (m.deleteStatus) {
        const e = new Error(`GOOGLE_DELETE_FAILED: eventId=${eventId} status=${m.deleteStatus}`);
        e.eventId = eventId;
        throw e;
      }
      const ev = m.events.get(eventId);
      if (!ev || ev.deleted) return { alreadyDeleted: true };
      ev.deleted = true;
      return { deleted: true };
    },
  };
  return m;
}

const silent = { error() {}, warn() {} };
const booking = (over = {}) => ({
  id: 1,
  status: 'ACCEPTED',
  date: new Date(Date.now() + 86400000),
  specialist: 'نطق',
  userName: 'أحمد',
  userEmail: 'parent@example.com',
  durationMinutes: 45,
  meetingUrl: null,
  meetingEventId: null,
  ...over,
});
const live = (meet) => [...meet.events].filter(([, e]) => !e.deleted).map(([id]) => id);

test('1) قبول الحجز ينشئ اجتماعًا ويحفظ الرابط والمعرّف', async () => {
  const prisma = fakePrisma([booking()]);
  const meet = fakeMeet();
  const lc = createMeetingLifecycle({ prisma, meet, logger: silent });
  const c = await lc.ensureMeeting(1);
  assert.match(c.meetingUrl, /^https:\/\/meet\.google\.com\//);
  assert.equal(c.meetingEventId, meet.created[0]);
  // استدعاء ثانٍ لا ينشئ اجتماعًا آخر
  await lc.ensureMeeting(1);
  assert.equal(meet.created.length, 1);
});

test('2) تغيير الموعد: يحذف القديم ثم ينشئ الجديد', async () => {
  const prisma = fakePrisma([booking()]);
  const meet = fakeMeet();
  const lc = createMeetingLifecycle({ prisma, meet, logger: silent });
  const first = await lc.ensureMeeting(1);
  // ما يفعله مسار reschedule: تحديث الموعد ومسح الرابط مع إبقاء المعرّف
  Object.assign(prisma.rows.get(1), { date: new Date(Date.now() + 2 * 86400000), status: 'CHANGED', meetingUrl: null });
  await lc.releaseMeeting(1, { reason: 'rescheduled' });
  assert.deepEqual(meet.deleted, [first.meetingEventId]);
  const second = await lc.ensureMeeting(1);
  assert.notEqual(second.meetingEventId, first.meetingEventId);
  assert.ok(second.meetingUrl);
  assert.deepEqual(live(meet), [second.meetingEventId]);
});

test('3+4) الرفض والإلغاء: حذف الاجتماع وتنظيف البيانات', async () => {
  for (const status of ['REJECTED', 'CANCELLED']) {
    const prisma = fakePrisma([booking()]);
    const meet = fakeMeet();
    const lc = createMeetingLifecycle({ prisma, meet, logger: silent });
    const c = await lc.ensureMeeting(1);
    prisma.rows.get(1).status = status;
    const after = await lc.releaseMeeting(1, { reason: status.toLowerCase() });
    assert.deepEqual(meet.deleted, [c.meetingEventId], status);
    assert.equal(after.meetingUrl, null);
    assert.equal(after.meetingEventId, null);
    assert.equal(after.status, status);
    // حجز مغلق لا يُنشأ له اجتماع جديد
    await lc.ensureMeeting(1);
    assert.equal(meet.created.length, 1);
  }
});

test('5) إعادة الإنشاء: لا يبقى اجتماع قديم', async () => {
  const prisma = fakePrisma([booking()]);
  const meet = fakeMeet();
  const lc = createMeetingLifecycle({ prisma, meet, logger: silent });
  await lc.ensureMeeting(1);
  await lc.releaseMeeting(1, { reason: 'regenerate' });
  const c = await lc.ensureMeeting(1);
  assert.equal(meet.created.length, 2);
  assert.deepEqual(live(meet), [c.meetingEventId]);
});

test('6) الحذف لحدث محذوف مسبقًا (404/410) يُعتبر نجاحًا وينظف البيانات', async () => {
  const prisma = fakePrisma([booking({ meetingUrl: 'https://meet.google.com/old-link-xyz', meetingEventId: 'uabberGone' })]);
  const meet = fakeMeet(); // الحدث غير موجود عند Google ← alreadyDeleted
  const lc = createMeetingLifecycle({ prisma, meet, logger: silent });
  const c = await lc.releaseMeeting(1, { reason: 'cancelled' });
  assert.equal(c.meetingEventId, null);
  assert.equal(prisma.pending.size, 0);
});

test('6b) فشل الحذف: يُسجّل المعرّف لإعادة المحاولة ثم يُنظّف الحجز، ولا يضيع', async () => {
  const prisma = fakePrisma([booking()]);
  const meet = fakeMeet();
  const lc = createMeetingLifecycle({ prisma, meet, logger: silent });
  const c = await lc.ensureMeeting(1);
  meet.deleteStatus = 500;
  const after = await lc.releaseMeeting(1, { reason: 'cancelled' });
  assert.equal(after.meetingEventId, null);
  assert.ok(prisma.pending.has(c.meetingEventId));
  // إعادة المحاولة لاحقًا تنجح وتفرغ القائمة
  meet.deleteStatus = null;
  const r = await lc.retryPendingDeletions();
  assert.deepEqual(r, { deleted: 1, failed: 0, remaining: 0 });
  assert.deepEqual(live(meet), []);
});

test('6c) فشل الحذف وفشل تسجيله: يبقى المعرّف في الحجز ويختفي الرابط فقط', async () => {
  const prisma = fakePrisma([booking()]);
  const meet = fakeMeet();
  const lc = createMeetingLifecycle({ prisma, meet, logger: silent });
  const c = await lc.ensureMeeting(1);
  meet.deleteStatus = 500;
  prisma.failPendingWrites = true;
  const after = await lc.releaseMeeting(1, { reason: 'cancelled' });
  assert.equal(after.meetingUrl, null);
  assert.equal(after.meetingEventId, c.meetingEventId);
});

test('7) فشل Google عند الإنشاء: الحجز سليم وبدون حجز عالق', async () => {
  const prisma = fakePrisma([booking()]);
  const meet = fakeMeet();
  meet.createError = new Error('GOOGLE_AUTH_FAILED: invalid_grant');
  const lc = createMeetingLifecycle({ prisma, meet, logger: silent });
  const c = await lc.ensureMeeting(1);
  assert.equal(c.status, 'ACCEPTED');
  assert.equal(c.meetingUrl, null);
  assert.equal(c.meetingEventId, null);
  // عند عودة Google يُنشأ الاجتماع بشكل طبيعي
  meet.createError = null;
  assert.ok((await lc.ensureMeeting(1)).meetingUrl);
});

test('7b) حدث أُنشئ بلا رابط: يُحذف ولا تبقى دعوة', async () => {
  const prisma = fakePrisma([booking()]);
  const meet = fakeMeet();
  const err = new Error('GOOGLE_MEET_LINK_MISSING');
  err.eventId = 'uabberHalf';
  meet.events.set('uabberHalf', { deleted: false });
  meet.createError = err;
  const lc = createMeetingLifecycle({ prisma, meet, logger: silent });
  await lc.ensureMeeting(1);
  assert.deepEqual(meet.deleted, ['uabberHalf']);
  assert.deepEqual(live(meet), []);
});

test('8) طلبات متزامنة (أدمن + أخصائي): اجتماع واحد فقط', async () => {
  const prisma = fakePrisma([booking()]);
  const meet = fakeMeet({ createDelay: 20 });
  const lc = createMeetingLifecycle({ prisma, meet, logger: silent });
  await Promise.all([lc.ensureMeeting(1), lc.ensureMeeting(1), lc.ensureMeeting(1)]);
  assert.equal(meet.created.length, 1);
  const c = prisma.rows.get(1);
  assert.equal(c.meetingEventId, meet.created[0]);
  assert.ok(c.meetingUrl);
});

test('8b) إلغاء أثناء الإنشاء: الاجتماع الذي أُنشئ متأخرًا يُحذف', async () => {
  const prisma = fakePrisma([booking()]);
  const meet = fakeMeet({ createDelay: 20 });
  const lc = createMeetingLifecycle({ prisma, meet, logger: silent });
  const creating = lc.ensureMeeting(1);
  await new Promise((r) => setTimeout(r, 5));
  prisma.rows.get(1).status = 'CANCELLED';
  await lc.releaseMeeting(1, { reason: 'cancelled' });
  await creating;
  const c = prisma.rows.get(1);
  assert.equal(c.meetingUrl, null);
  assert.equal(c.meetingEventId, null);
  assert.deepEqual(live(meet), []);
});

test('8c) حجز عالق قديم (انقطع الطلب): يُنظف ويُعاد الإنشاء', async () => {
  let clock = Date.now();
  const prisma = fakePrisma([booking({ meetingEventId: `pending:uabberStuck:${clock}` })]);
  const meet = fakeMeet();
  const lc = createMeetingLifecycle({ prisma, meet, logger: silent, now: () => clock });
  // داخل مهلة الحجز: لا شيء
  assert.equal((await lc.ensureMeeting(1)).meetingUrl, null);
  assert.equal(meet.created.length, 0);
  clock += CLAIM_TTL_MS + 1;
  const c = await lc.ensureMeeting(1);
  assert.ok(meet.deleted.includes('uabberStuck'));
  assert.ok(c.meetingUrl);
});

test('9) بدون مفاتيح Google: لا شيء يتغير والرابط اليدوي يبقى', async () => {
  const prisma = fakePrisma([booking({ meetingUrl: 'https://meet.google.com/man-uall-ink' })]);
  const meet = fakeMeet();
  meet.configured = false;
  const lc = createMeetingLifecycle({ prisma, meet, logger: silent });
  const c = await lc.ensureMeeting(1);
  assert.equal(c.meetingUrl, 'https://meet.google.com/man-uall-ink');
  assert.equal(meet.created.length, 0);
});
