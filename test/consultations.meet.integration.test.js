// اختبارات تكامل: السيرفر الحقيقي + قاعدة بيانات Postgres + خادم Google وهمي.
// تعمل فقط عند ضبط TEST_DATABASE_URL (قاعدة اختبار، لا تستخدم قاعدة الإنتاج):
//   TEST_DATABASE_URL=postgresql://... npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = DB_URL ? false : 'ضع TEST_DATABASE_URL لتشغيل اختبارات التكامل';

// ---------------------------------------------------------------------------
// خادم Google وهمي
// ---------------------------------------------------------------------------
const google = {
  events: new Map(), // id -> { deleted, attendees, start }
  inserts: [],
  deletes: [], // { id, sendUpdates, status }
  createDelayMs: 0,
  createFail: false,
  deleteStatus: null, // null = 204
};
let seq = 0;
function startGoogle() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const chunk of req) body += chunk;
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    if (url.pathname === '/token') return send(200, { access_token: 'tok' });

    const m = url.pathname.match(/^\/calendar\/v3\/calendars\/[^/]+\/events(?:\/([^/]+))?$/);
    if (!m) return send(404, { error: { message: 'no route' } });
    const id = m[1] && decodeURIComponent(m[1]);

    if (req.method === 'POST' && !id) {
      if (google.createDelayMs) await new Promise((r) => setTimeout(r, google.createDelayMs));
      if (google.createFail) return send(500, { error: { message: 'Backend Error' } });
      const ev = JSON.parse(body);
      if (google.events.has(ev.id)) return send(409, { error: { message: 'duplicate' } });
      // رابط بصيغة Meet الحقيقية (أحرف فقط)
      let n = ++seq;
      let letters = '';
      for (let i = 0; i < 4; i += 1) {
        letters = String.fromCharCode(97 + (n % 26)) + letters;
        n = Math.floor(n / 26);
      }
      const link = `https://meet.google.com/abc-${letters}-xyz`;
      google.events.set(ev.id, { deleted: false, attendees: ev.attendees, start: ev.start, link });
      google.inserts.push(ev.id);
      return send(200, { id: ev.id, status: 'confirmed', hangoutLink: link });
    }
    if (req.method === 'GET' && id) {
      const ev = google.events.get(id);
      return ev ? send(200, { id, hangoutLink: ev.link, status: ev.deleted ? 'cancelled' : 'confirmed' }) : send(404, {});
    }
    if (req.method === 'DELETE' && id) {
      const status = google.deleteStatus || (google.events.get(id)?.deleted || !google.events.has(id) ? 410 : 204);
      google.deletes.push({ id, sendUpdates: url.searchParams.get('sendUpdates'), status });
      if (status === 204) google.events.get(id).deleted = true;
      return send(status, status === 204 ? undefined : { error: { message: 'x' } });
    }
    return send(405, {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
const liveEvents = () => [...google.events].filter(([, e]) => !e.deleted).map(([id]) => id);

// ---------------------------------------------------------------------------
// تشغيل السيرفر الحقيقي + بيانات الاختبار
// ---------------------------------------------------------------------------
let api;
let googleServer;
let prisma;
let base;
const tokens = {};
const ids = { users: [], consultations: [], slots: [], profile: null };
const tag = `meettest${Date.now()}`;

async function call(method, url, token, body) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

let slotOffset = 0;
async function newSlot() {
  slotOffset += 1;
  const slot = await prisma.specialistAvailability.create({
    data: {
      specialist: 'أخصائي/ة نطق',
      startAt: new Date(Date.now() + (3 + slotOffset) * 86400000),
      durationMinutes: 45,
      isAvailable: true,
      specialistProfileId: ids.profile,
    },
  });
  ids.slots.push(slot.id);
  return slot;
}

async function newBooking() {
  const slot = await newSlot();
  await prisma.specialistAvailability.update({ where: { id: slot.id }, data: { isAvailable: false } });
  const c = await prisma.consultation.create({
    data: {
      userId: ids.parent,
      availabilityId: slot.id,
      userName: 'ولي أمر',
      userEmail: `${tag}parent@example.com`,
      specialist: slot.specialist,
      date: slot.startAt,
      time: slot.startAt.toISOString().slice(11, 16),
      durationMinutes: 45,
      specialistProfileId: ids.profile,
    },
  });
  ids.consultations.push(c.id);
  return c;
}

test.before(async () => {
  if (skip) return;
  googleServer = await startGoogle();
  const gPort = googleServer.address().port;
  process.env.DATABASE_URL = DB_URL;
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const jwt = require('jsonwebtoken');
  const secret = 'integration-secret';

  const mkUser = async (role, name) => {
    const u = await prisma.user.create({
      data: {
        fullName: name,
        email: `${tag}${name}@example.com`,
        passwordHash: 'x',
        role,
        trialExpiryDate: new Date(Date.now() + 86400000),
      },
    });
    ids.users.push(u.id);
    tokens[name] = jwt.sign({ id: u.id }, secret);
    return u;
  };
  await mkUser('ADMIN', 'admin');
  const parent = await mkUser('USER', 'parent');
  ids.parent = parent.id;
  const doctor = await mkUser('USER', 'doctor');
  const profile = await prisma.specialistProfile.create({
    data: {
      userId: doctor.id,
      displayName: 'د. اختبار',
      specialty: 'speech',
      status: 'APPROVED',
      subscriptionExpiry: new Date(Date.now() + 30 * 86400000),
    },
  });
  ids.profile = profile.id;

  const port = 40000 + Math.floor(Math.random() * 10000);
  base = `http://127.0.0.1:${port}`;
  api = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: DB_URL,
      JWT_SECRET: secret,
      GOOGLE_CLIENT_ID: 'test-client',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      GOOGLE_REFRESH_TOKEN: 'test-refresh',
      GOOGLE_OAUTH_TOKEN_URL: `http://127.0.0.1:${gPort}/token`,
      GOOGLE_CALENDAR_API_BASE: `http://127.0.0.1:${gPort}/calendar/v3`,
      GOOGLE_MEET_POLL_MS: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  api.stderr.on('data', () => {});
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('السيرفر لم يبدأ');
});

test.after(async () => {
  if (skip) return;
  api?.kill();
  googleServer?.close();
  await prisma.pendingMeetingDeletion.deleteMany({ where: { eventId: { in: [...google.events.keys()] } } });
  await prisma.consultation.deleteMany({ where: { id: { in: ids.consultations } } });
  await prisma.specialistAvailability.deleteMany({ where: { id: { in: ids.slots } } });
  await prisma.specialistProfile.deleteMany({ where: { id: ids.profile } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await prisma.$disconnect();
});

const reset = () => {
  google.createDelayMs = 0;
  google.createFail = false;
  google.deleteStatus = null;
};

// ---------------------------------------------------------------------------

test('1) قبول الحجز ينشئ اجتماعًا ويرسل الدعوات', { skip }, async () => {
  reset();
  const c = await newBooking();
  const r = await call('PUT', `/api/consultations/${c.id}/status`, tokens.admin, { status: 'ACCEPTED' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ACCEPTED');
  assert.match(r.body.meetingUrl, /^https:\/\/meet\.google\.com\//);
  const ev = google.events.get(r.body.meetingEventId);
  assert.ok(ev, 'الحدث موجود عند Google');
  assert.ok(ev.attendees.some((a) => a.email === `${tag}parent@example.com`));
  assert.ok(ev.attendees.some((a) => a.email === `${tag}doctor@example.com`));
});

test('2) تغيير الموعد: حذف القديم (sendUpdates=all) وإنشاء الجديد', { skip }, async () => {
  reset();
  const c = await newBooking();
  const accepted = (await call('PUT', `/api/consultations/${c.id}/status`, tokens.admin, { status: 'ACCEPTED' })).body;
  const target = await newSlot();
  const r = await call('PUT', `/api/consultations/${c.id}/reschedule`, tokens.doctor, { availabilityId: target.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'CHANGED');
  assert.equal(new Date(r.body.date).getTime(), target.startAt.getTime());
  const del = google.deletes.find((d) => d.id === accepted.meetingEventId);
  assert.ok(del, 'الاجتماع القديم حُذف');
  assert.equal(del.sendUpdates, 'all');
  assert.notEqual(r.body.meetingEventId, accepted.meetingEventId);
  assert.ok(r.body.meetingUrl);
  assert.equal(google.events.get(r.body.meetingEventId).start.dateTime, target.startAt.toISOString());
});

test('3) رفض الحجز: حذف الاجتماع وتنظيف البيانات', { skip }, async () => {
  reset();
  const c = await newBooking();
  const accepted = (await call('PUT', `/api/consultations/${c.id}/status`, tokens.admin, { status: 'ACCEPTED' })).body;
  const r = await call('PUT', `/api/consultations/${c.id}/status`, tokens.doctor, {
    status: 'REJECTED',
    rejectionReason: 'غير متاح',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'REJECTED');
  assert.equal(r.body.meetingUrl, null);
  assert.equal(r.body.meetingEventId, null);
  assert.equal(google.events.get(accepted.meetingEventId).deleted, true);
  assert.equal(google.deletes.find((d) => d.id === accepted.meetingEventId).sendUpdates, 'all');
  // الموعد يعود متاحًا كما في السابق
  const slot = await prisma.specialistAvailability.findUnique({ where: { id: c.availabilityId } });
  assert.equal(slot.isAvailable, true);
});

test('4) إلغاء الحجز: حذف الاجتماع وتنظيف البيانات', { skip }, async () => {
  reset();
  const c = await newBooking();
  const accepted = (await call('PUT', `/api/consultations/${c.id}/status`, tokens.admin, { status: 'ACCEPTED' })).body;
  const r = await call('PUT', `/api/consultations/${c.id}/status`, tokens.admin, { status: 'CANCELLED' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'CANCELLED');
  assert.equal(r.body.meetingEventId, null);
  assert.equal(google.events.get(accepted.meetingEventId).deleted, true);
});

test('5) إعادة الإنشاء التلقائي: لا يبقى اجتماع قديم', { skip }, async () => {
  reset();
  const c = await newBooking();
  const accepted = (await call('PUT', `/api/consultations/${c.id}/status`, tokens.admin, { status: 'ACCEPTED' })).body;
  const r = await call('PUT', `/api/consultations/${c.id}/meeting`, tokens.admin, { auto: true });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.meetingEventId, accepted.meetingEventId);
  assert.equal(google.events.get(accepted.meetingEventId).deleted, true);
  assert.equal(google.events.get(r.body.meetingEventId).deleted, false);
});

test('6) حذف حدث محذوف مسبقًا (410): نجاح وتنظيف بدون تسجيل معلّق', { skip }, async () => {
  reset();
  const c = await newBooking();
  const accepted = (await call('PUT', `/api/consultations/${c.id}/status`, tokens.admin, { status: 'ACCEPTED' })).body;
  google.events.get(accepted.meetingEventId).deleted = true; // حُذف من التقويم يدويًا
  const r = await call('PUT', `/api/consultations/${c.id}/status`, tokens.admin, { status: 'CANCELLED' });
  assert.equal(r.status, 200);
  assert.equal(r.body.meetingEventId, null);
  assert.equal(google.deletes.find((d) => d.id === accepted.meetingEventId).status, 410);
  assert.equal(await prisma.pendingMeetingDeletion.count({ where: { eventId: accepted.meetingEventId } }), 0);
});

test('7) فشل Google: القبول والإلغاء ينجحان رغم ذلك', { skip }, async () => {
  reset();
  // فشل الإنشاء
  google.createFail = true;
  const c = await newBooking();
  const r = await call('PUT', `/api/consultations/${c.id}/status`, tokens.admin, { status: 'ACCEPTED' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ACCEPTED');
  assert.equal(r.body.meetingUrl, null);
  assert.equal(r.body.meetingEventId, null);
  // عند عودة Google: إنشاء يدوي تلقائي يعمل
  google.createFail = false;
  const regen = await call('PUT', `/api/consultations/${c.id}/meeting`, tokens.admin, { auto: true });
  assert.equal(regen.status, 200);
  const eventId = regen.body.meetingEventId;

  // فشل الحذف: الإلغاء ينجح، والمعرّف يُحفظ لإعادة المحاولة
  google.deleteStatus = 500;
  const cancel = await call('PUT', `/api/consultations/${c.id}/status`, tokens.admin, { status: 'CANCELLED' });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.status, 'CANCELLED');
  assert.equal(cancel.body.meetingUrl, null);
  const pending = await prisma.pendingMeetingDeletion.findUnique({ where: { eventId } });
  assert.ok(pending, 'المعرّف محفوظ لإعادة الحذف');
  assert.equal(pending.consultationId, c.id);

  // اختبار Meet من لوحة الأدمن يعيد حذف العالق
  google.deleteStatus = null;
  const t = await call('POST', '/api/consultations/meeting-test', tokens.admin);
  assert.equal(t.status, 200);
  assert.equal(t.body.ok, true);
  assert.ok(t.body.pendingCleanup.deleted >= 1);
  assert.equal(google.events.get(eventId).deleted, true);
  assert.equal(await prisma.pendingMeetingDeletion.count({ where: { eventId } }), 0);
});

test('7b) اختبار Meet: فشل حذف الاجتماع التجريبي لا يُخفى', { skip }, async () => {
  reset();
  google.deleteStatus = 500;
  const t = await call('POST', '/api/consultations/meeting-test', tokens.admin);
  assert.equal(t.status, 200);
  assert.equal(t.body.ok, true);
  assert.equal(t.body.cleanupFailed, true);
  assert.ok(t.body.eventId);
  assert.match(t.body.message, new RegExp(t.body.eventId));
  google.deleteStatus = null;
});

test('8) طلبات قبول متزامنة (أدمن + أخصائي): اجتماع واحد فقط', { skip }, async () => {
  reset();
  google.createDelayMs = 150;
  const c = await newBooking();
  const before = google.inserts.length;
  const [a, b] = await Promise.all([
    call('PUT', `/api/consultations/${c.id}/status`, tokens.admin, { status: 'ACCEPTED' }),
    call('PUT', `/api/consultations/${c.id}/status`, tokens.doctor, { status: 'ACCEPTED' }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(google.inserts.length - before, 1, 'تم إنشاء اجتماع واحد فقط');
  const row = await prisma.consultation.findUnique({ where: { id: c.id } });
  assert.ok(row.meetingUrl);
  assert.equal(row.meetingEventId, google.inserts[google.inserts.length - 1]);
});

test('9) الرابط اليدوي: يعمل، ويحذف الاجتماع التلقائي القديم، ويرفض الروابط غير الصالحة', { skip }, async () => {
  reset();
  const c = await newBooking();
  const accepted = (await call('PUT', `/api/consultations/${c.id}/status`, tokens.admin, { status: 'ACCEPTED' })).body;

  // حفظ نفس الرابط الحالي: لا شيء يتغير
  const same = await call('PUT', `/api/consultations/${c.id}/meeting`, tokens.doctor, { meetingUrl: accepted.meetingUrl });
  assert.equal(same.status, 200);
  assert.equal(same.body.meetingEventId, accepted.meetingEventId);
  assert.equal(google.events.get(accepted.meetingEventId).deleted, false);

  const bad = await call('PUT', `/api/consultations/${c.id}/meeting`, tokens.doctor, { meetingUrl: 'https://zoom.us/j/1' });
  assert.equal(bad.status, 400);

  const manual = 'https://meet.google.com/man-uall-ink';
  const r = await call('PUT', `/api/consultations/${c.id}/meeting`, tokens.doctor, { meetingUrl: manual });
  assert.equal(r.status, 200);
  assert.equal(r.body.meetingUrl, manual);
  assert.equal(r.body.meetingEventId, null);
  assert.equal(google.events.get(accepted.meetingEventId).deleted, true);

  // قبول لاحق لا يستبدل الرابط اليدوي
  const again = await call('PUT', `/api/consultations/${c.id}/status`, tokens.admin, { status: 'PAYMENT_CONFIRMED' });
  assert.equal(again.body.meetingUrl, manual);

  // ولي الأمر لا يملك صلاحية تعديل الرابط
  const forbidden = await call('PUT', `/api/consultations/${c.id}/meeting`, tokens.parent, { meetingUrl: manual });
  assert.equal(forbidden.status, 403);
});

test('10) لا تبقى اجتماعات حيّة لحجوزات مرفوضة/ملغاة', { skip }, async () => {
  const rows = await prisma.consultation.findMany({ where: { id: { in: ids.consultations } } });
  const liveIds = new Set(liveEvents());
  for (const r of rows) {
    if (['REJECTED', 'CANCELLED'].includes(r.status)) {
      assert.equal(r.meetingEventId, null, `consultation ${r.id}`);
    }
  }
  // كل حدث حيّ عند Google مرتبط بحجز فعّال (عدا اجتماعات الاختبار التي فشل حذفها عمدًا)
  const linked = new Set(rows.map((r) => r.meetingEventId).filter(Boolean));
  const orphans = [...liveIds].filter((id) => !linked.has(id) && !id.startsWith('uabber0c'));
  assert.deepEqual(orphans, []);
});
