// تكامل: الإشعارات (تأكيد، تذكير قبل 5 دقائق، إلغاء، تغيير موعد، إعادة المحاولة، منع التكرار)
// مع خادم FCM وهمي ومفتاح حساب خدمة مولّد للاختبار.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { DB_URL, startServer, fixtures } = require('./helpers/server');

const skip = DB_URL ? false : 'ضع TEST_DATABASE_URL لتشغيل اختبارات التكامل';

// --- FCM وهمي ---
const fcmMock = { messages: [], mode: 'ok', tokenRequests: 0 };
let fcmServer;
function startFcm() {
  fcmServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.url === '/token') {
      fcmMock.tokenRequests += 1;
      const assertion = new URLSearchParams(body).get('assertion') || '';
      return assertion.split('.').length === 3 ? json(200, { access_token: 'fcm-access', expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
    }
    const message = JSON.parse(body || '{}').message;
    fcmMock.messages.push({ url: req.url, auth: req.headers.authorization, message });
    if (fcmMock.mode === 'error') return json(503, { error: { status: 'UNAVAILABLE', message: 'try later' } });
    if (fcmMock.mode === 'unregistered') {
      return json(404, { error: { status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ errorCode: 'UNREGISTERED' }] } });
    }
    return json(200, { name: 'projects/test/messages/1' });
  });
  return new Promise((r) => fcmServer.listen(0, '127.0.0.1', r));
}

let prisma;
let api;
let fx;
let admin;
let parent;
let doc;
let lib;

test.before(async () => {
  if (skip) return;
  await startFcm();
  const port = fcmServer.address().port;
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
    project_id: 'uabber-test',
    client_email: 'test@uabber-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: `http://127.0.0.1:${port}/token`,
  });
  process.env.FCM_API_BASE = `http://127.0.0.1:${port}`;
  process.env.DATABASE_URL = DB_URL;

  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  lib = require('../src/services/notifications');
  fx = fixtures(prisma, `notif${Date.now()}`);
  admin = await fx.user('admin', 'ADMIN');
  parent = await fx.user('parent');
  doc = await fx.specialist('doc', { days: 30 });
  api = await startServer();
});

test.after(async () => {
  if (skip) return;
  api.stop();
  fcmServer.close();
  await prisma.userNotification.deleteMany({ where: { userId: { in: fx.ids.users } } });
  await prisma.deviceToken.deleteMany({ where: { userId: { in: fx.ids.users } } });
  await fx.cleanup();
  await prisma.$disconnect();
});

let offset = 0;
async function booking() {
  offset += 1;
  const slot = await prisma.specialistAvailability.create({
    data: {
      specialist: 'أخصائي/ة نطق',
      specialistProfileId: doc.profile.id,
      startAt: new Date(Date.now() + (2 + offset) * 86400000),
      durationMinutes: 45,
    },
  });
  const form = new FormData();
  form.append('userName', 'أم سارة');
  form.append('phone', '0791234567');
  form.append('availabilityId', String(slot.id));
  form.append('receipt', new Blob([Buffer.from('x')], { type: 'image/png' }), 'r.png');
  const r = await api.call('POST', '/api/consultations', parent.token, form);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

const rows = (consultationId, extra = {}) =>
  prisma.userNotification.findMany({ where: { consultationId, ...extra }, orderBy: { id: 'asc' } });

const service = (now) => lib.createNotifications({ prisma, now: () => now, logger: { error() {} } });

test('حجز جديد يُشعر الأخصائي، والتأكيد يُشعر الطرفين ويجدول تذكيرًا قبل 5 دقائق بالضبط', { skip }, async () => {
  const c = await booking();
  const created = await rows(c.id);
  assert.equal(created.length, 1);
  assert.equal(created[0].type, 'booking_new');
  assert.equal(created[0].userId, doc.user.id);

  await api.call('PUT', `/api/consultations/${c.id}/status`, doc.token, { status: 'ACCEPTED' });
  const confirmed = await rows(c.id, { type: 'booking_confirmed' });
  assert.deepEqual(confirmed.map((n) => n.userId).sort(), [parent.id, doc.user.id].sort());

  const reminders = await rows(c.id, { type: 'reminder' });
  assert.equal(reminders.length, 2);
  const date = new Date(c.date);
  for (const r of reminders) {
    assert.equal(r.scheduledAt.getTime(), date.getTime() - 5 * 60000, 'exactly 5 minutes before');
    assert.equal(r.status, 'PENDING');
  }

  // قبول مكرر لا يكرر الإشعارات
  await api.call('PUT', `/api/consultations/${c.id}/status`, admin.token, { status: 'ACCEPTED' });
  assert.equal((await rows(c.id, { type: 'reminder' })).length, 2);
  assert.equal((await rows(c.id, { type: 'booking_confirmed' })).length, 2);
});

test('التذكير يُرسل في وقته للأجهزة المسجلة، ولا يُرسل قبل وقته', { skip }, async () => {
  const c = await booking();
  const reg = await api.call('POST', '/api/notifications/devices', parent.token, { token: `parent-device-token-${c.id}-xxxxxxxx`, platform: 'android' });
  assert.equal(reg.status, 201);
  await api.call('POST', '/api/notifications/devices', doc.token, { token: `doc-device-token-${c.id}-xxxxxxxxxxx`, platform: 'ios' });
  await api.call('PUT', `/api/consultations/${c.id}/status`, doc.token, { status: 'ACCEPTED' });
  const date = new Date(c.date);

  // التأكيد الفوري يُرسل الآن
  fcmMock.messages = [];
  await service(new Date()).processDue();
  const immediate = fcmMock.messages.filter((m) => m.message.data.consultationId === String(c.id));
  assert.ok(immediate.some((m) => m.message.data.type === 'booking_confirmed'));
  assert.ok(immediate.every((m) => m.auth === 'Bearer fcm-access'));
  assert.ok(!immediate.some((m) => m.message.data.type === 'reminder'), 'reminder not before its time');

  // بعد الوصول لوقت التذكير (قبل الموعد بـ 5 دقائق)
  fcmMock.messages = [];
  await service(new Date(date.getTime() - 5 * 60000 + 1000)).processDue();
  const sent = fcmMock.messages.filter((m) => m.message.data.type === 'reminder' && m.message.data.consultationId === String(c.id));
  assert.deepEqual(
    sent.map((m) => m.message.token).sort(),
    [`doc-device-token-${c.id}-xxxxxxxxxxx`, `parent-device-token-${c.id}-xxxxxxxx`].sort()
  );
  assert.match(sent[0].message.notification.title, /تذكير/);
  assert.equal(sent[0].message.data.route, 'consultation', 'tap opens the appointment');
  assert.equal(sent[0].message.android.priority, 'high');
  const reminders = await rows(c.id, { type: 'reminder' });
  assert.ok(reminders.every((r) => r.status === 'SENT' && r.sentAt));

  // تشغيل ثانٍ لا يعيد الإرسال
  fcmMock.messages = [];
  await service(new Date(date.getTime() - 4 * 60000)).processDue();
  assert.equal(fcmMock.messages.filter((m) => m.message.data.consultationId === String(c.id)).length, 0);
});

test('إلغاء الموعد يلغي التذكير ويُشعر الطرفين', { skip }, async () => {
  const c = await booking();
  await api.call('PUT', `/api/consultations/${c.id}/status`, doc.token, { status: 'ACCEPTED' });
  await api.call('PUT', `/api/consultations/${c.id}/status`, admin.token, { status: 'CANCELLED' });
  const reminders = await rows(c.id, { type: 'reminder' });
  assert.ok(reminders.length === 2 && reminders.every((r) => r.status === 'CANCELLED'));
  const notices = await rows(c.id, { type: 'booking_cancelled' });
  assert.deepEqual(notices.map((n) => n.userId).sort(), [parent.id, doc.user.id].sort());

  fcmMock.messages = [];
  await service(new Date(new Date(c.date).getTime() - 5 * 60000 + 1000)).processDue();
  assert.ok(!fcmMock.messages.some((m) => m.message.data.type === 'reminder' && m.message.data.consultationId === String(c.id)));
});

test('تغيير الموعد يلغي التذكير القديم ويجدول تذكيرًا للموعد الجديد', { skip }, async () => {
  const c = await booking();
  await api.call('PUT', `/api/consultations/${c.id}/status`, doc.token, { status: 'ACCEPTED' });
  offset += 1;
  const target = await prisma.specialistAvailability.create({
    data: {
      specialist: 'أخصائي/ة نطق',
      specialistProfileId: doc.profile.id,
      startAt: new Date(Date.now() + (2 + offset) * 86400000),
      durationMinutes: 45,
    },
  });
  const r = await api.call('PUT', `/api/consultations/${c.id}/reschedule`, doc.token, { availabilityId: target.id });
  assert.equal(r.status, 200);
  const reminders = await rows(c.id, { type: 'reminder' });
  const pending = reminders.filter((x) => x.status === 'PENDING');
  const cancelled = reminders.filter((x) => x.status === 'CANCELLED');
  assert.equal(cancelled.length, 2);
  assert.equal(pending.length, 2);
  for (const p of pending) assert.equal(p.scheduledAt.getTime(), target.startAt.getTime() - 5 * 60000);
  assert.equal((await rows(c.id, { type: 'booking_changed' })).length, 2);
});

test('فشل الإرسال: إعادة محاولة ثم FAILED، والرمز غير الصالح يُحذف', { skip }, async () => {
  const c = await booking();
  await prisma.userNotification.deleteMany({ where: { consultationId: c.id } });
  await api.call('POST', '/api/notifications/devices', parent.token, { token: `retry-token-${c.id}-xxxxxxxxxxxxx`, platform: 'android' });
  const n = await prisma.userNotification.create({
    data: { userId: parent.id, type: 'booking_confirmed', title: 't', body: 'b', consultationId: c.id, dedupeKey: `retry-test:${c.id}` },
  });
  fcmMock.mode = 'error';
  let t = new Date();
  for (let i = 1; i <= 5; i += 1) {
    await service(t).processDue();
    const row = await prisma.userNotification.findUnique({ where: { id: n.id } });
    assert.equal(row.attempts, i);
    if (i < 5) {
      assert.equal(row.status, 'PENDING');
      assert.ok(row.scheduledAt > t, 'retry later with backoff');
      t = new Date(row.scheduledAt.getTime() + 1000);
    } else {
      assert.equal(row.status, 'FAILED');
      assert.match(row.lastError, /503/);
    }
  }

  fcmMock.mode = 'unregistered';
  const n2 = await prisma.userNotification.create({
    data: { userId: parent.id, type: 'booking_confirmed', title: 't', body: 'b', consultationId: c.id, dedupeKey: `unreg-test:${c.id}` },
  });
  await service(new Date()).processDue();
  assert.equal((await prisma.userNotification.findUnique({ where: { id: n2.id } })).status, 'FAILED');
  assert.equal(await prisma.deviceToken.count({ where: { token: `retry-token-${c.id}-xxxxxxxxxxxxx` } }), 0);
  fcmMock.mode = 'ok';
});

test('بدون إعداد Firebase: الإشعار يُحفظ (SKIPPED) ويظهر داخل التطبيق', { skip }, async () => {
  const c = await booking();
  const skipped = lib.createNotifications({
    prisma,
    sender: { isFcmConfigured: () => false, sendToDevice: async () => ({ ok: true }) },
  });
  await skipped.processDue();
  const row = (await rows(c.id, { type: 'booking_new' }))[0];
  assert.equal(row.status, 'SKIPPED');
  assert.equal(row.lastError, 'FCM_NOT_CONFIGURED');

  const mine = await api.call('GET', '/api/notifications/mine', doc.token);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.items.some((x) => x.consultationId === c.id && x.type === 'booking_new'));
  assert.ok(mine.body.unread >= 1);
  // التذكيرات المستقبلية لا تظهر قبل وقتها
  assert.ok(!mine.body.items.some((x) => x.type === 'reminder' && new Date(x.scheduledAt) > new Date()));
  const read = await api.call('POST', '/api/notifications/mine/read-all', doc.token);
  assert.ok(read.body.updated >= 1);
  assert.equal((await api.call('GET', '/api/notifications/mine', doc.token)).body.unread, 0);
});

test('تسجيل الأجهزة: تحقق من المدخلات، ونقل الرمز للمستخدم الحالي، والحذف', { skip }, async () => {
  assert.equal((await api.call('POST', '/api/notifications/devices', parent.token, { token: 'short', platform: 'android' })).status, 400);
  assert.equal((await api.call('POST', '/api/notifications/devices', parent.token, { token: 'x'.repeat(40), platform: 'symbian' })).status, 400);
  assert.equal((await api.call('POST', '/api/notifications/devices', null, { token: 'x'.repeat(40), platform: 'ios' })).status, 401);
  const token = `shared-device-${Date.now()}-xxxxxxxxxxxx`;
  await api.call('POST', '/api/notifications/devices', parent.token, { token, platform: 'ios' });
  await api.call('POST', '/api/notifications/devices', doc.token, { token, platform: 'ios' });
  const row = await prisma.deviceToken.findUnique({ where: { token } });
  assert.equal(row.userId, doc.user.id);
  const del = await api.call('DELETE', '/api/notifications/devices', doc.token, { token });
  assert.equal(del.body.removed, 1);
});
