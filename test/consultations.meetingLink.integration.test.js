// اختبارات تكامل لرابط الاجتماع اليدوي وإرساله عبر واتساب:
// السيرفر الحقيقي + Postgres + خادم WhatsApp وهمي + خادم «Google» وهمي (للتأكد أنه لا يُستدعى).
// تعمل فقط مع قاعدة اختبار: TEST_DATABASE_URL=postgresql://... npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = DB_URL ? false : 'ضع TEST_DATABASE_URL لتشغيل اختبارات التكامل';
const COOLDOWN = 400;

// --- خوادم وهمية ---
const wa = { messages: [], fail: false, delayMs: 0 };
let googleHits = 0;
function startMock(handler) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    handler(req, body, res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// --- حالة الاختبار ---
let prisma;
let waServer;
let googleServer;
const servers = {}; // api | link → { proc, base }
const tokens = {};
const ids = { users: [], consultations: [], slots: [], profiles: [] };
const tag = `linktest${Date.now()}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(mode, method, url, token, body) {
  const response = await fetch(`${servers[mode].base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

let slotOffset = 0;
async function newBooking({ status = 'NEW', phone = '0791234567', profileId = ids.profiles[0] } = {}) {
  slotOffset += 1;
  const slot = await prisma.specialistAvailability.create({
    data: {
      specialist: 'أخصائي/ة نطق',
      startAt: new Date(Date.now() + (3 + slotOffset) * 86400000),
      durationMinutes: 45,
      isAvailable: false,
      specialistProfileId: profileId,
    },
  });
  ids.slots.push(slot.id);
  const c = await prisma.consultation.create({
    data: {
      userId: ids.parent,
      availabilityId: slot.id,
      userName: 'أم أحمد',
      userEmail: `${tag}parent@example.com`,
      phone,
      specialist: slot.specialist,
      date: slot.startAt,
      time: slot.startAt.toISOString().slice(11, 16),
      durationMinutes: 45,
      priceJod: 10,
      status,
      specialistProfileId: profileId,
    },
  });
  ids.consultations.push(c.id);
  return c;
}

async function startApi(mode, extraEnv, secret) {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_URL: DB_URL, JWT_SECRET: secret, ...extraEnv },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const base = `http://127.0.0.1:${port}`;
  servers[mode] = { proc, base };
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch (_) {}
    await wait(200);
  }
  throw new Error(`server ${mode} did not start`);
}

test.before(async () => {
  if (skip) return;
  waServer = await startMock((req, body, res) => {
    const send = async () => {
      if (wa.delayMs) await wait(wa.delayMs);
      wa.messages.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      if (wa.fail) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Recipient not on WhatsApp' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages: [{ id: `wamid.${wa.messages.length}` }] }));
    };
    send();
  });
  googleServer = await startMock((_req, _body, res) => {
    googleHits += 1;
    res.writeHead(500);
    res.end();
  });

  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const jwt = require('jsonwebtoken');
  const secret = 'link-test-secret';
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
  ids.parent = (await mkUser('USER', 'parent')).id;
  for (const name of ['doctor', 'otherdoctor']) {
    const u = await mkUser('USER', name);
    const p = await prisma.specialistProfile.create({
      data: {
        userId: u.id,
        displayName: name === 'doctor' ? 'د. سارة' : 'د. آخر',
        specialty: 'speech',
        status: 'APPROVED',
        subscriptionExpiry: new Date(Date.now() + 30 * 86400000),
      },
    });
    ids.profiles.push(p.id);
  }

  const gBase = `http://127.0.0.1:${googleServer.address().port}`;
  const common = {
    MEETING_SEND_COOLDOWN_MS: String(COOLDOWN),
    // حتى لو بقيت متغيرات Google موجودة على السيرفر، لا يجب أن يُستدعى أي شيء
    GOOGLE_CLIENT_ID: 'x',
    GOOGLE_CLIENT_SECRET: 'x',
    GOOGLE_REFRESH_TOKEN: 'x',
    GOOGLE_OAUTH_TOKEN_URL: `${gBase}/token`,
    GOOGLE_CALENDAR_API_BASE: `${gBase}/calendar/v3`,
  };
  await startApi('api', {
    ...common,
    WHATSAPP_TOKEN: 'wa-test-token',
    WHATSAPP_PHONE_NUMBER_ID: '1234567890',
    WHATSAPP_TEMPLATE_NAME: 'meeting_link',
    WHATSAPP_API_BASE: `http://127.0.0.1:${waServer.address().port}/v21.0`,
  }, secret);
  await startApi('link', { ...common, WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', WHATSAPP_TEMPLATE_NAME: '' }, secret);
});

test.after(async () => {
  if (skip) return;
  for (const s of Object.values(servers)) s.proc.kill();
  waServer?.close();
  googleServer?.close();
  await prisma.consultation.deleteMany({ where: { id: { in: ids.consultations } } });
  await prisma.specialistAvailability.deleteMany({ where: { id: { in: ids.slots } } });
  await prisma.specialistProfile.deleteMany({ where: { id: { in: ids.profiles } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await prisma.$disconnect();
});

const LINK = 'https://meet.google.com/abc-defg-hij';
const LINK2 = 'https://meet.google.com/xyz-wxyz-klm';

test('1+2) القبول وتأكيد الدفع وتغيير الموعد بدون أي إنشاء اجتماع أو استدعاء Google', { skip }, async () => {
  const c = await newBooking();
  const paid = await call('api', 'PUT', `/api/consultations/${c.id}/status`, tokens.admin, { status: 'PAYMENT_CONFIRMED' });
  assert.equal(paid.status, 200);
  const r = await call('api', 'PUT', `/api/consultations/${c.id}/status`, tokens.doctor, { status: 'ACCEPTED' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ACCEPTED');
  assert.equal(r.body.meetingUrl, null);
  const regen = await call('api', 'PUT', `/api/consultations/${c.id}/meeting`, tokens.admin, { auto: true });
  assert.equal(regen.status, 400);
  const t = await call('api', 'POST', '/api/consultations/meeting-test', tokens.admin);
  assert.equal(t.status, 410);
  const cfg = await call('api', 'GET', '/api/consultations/meeting-config', tokens.doctor);
  assert.equal(cfg.body.autoMeet, false);
  assert.equal(googleHits, 0);
});

test('3) الأخصائي يحفظ رابطًا يدويًا (يُوحَّد)، والروابط غير الصالحة تُرفض', { skip }, async () => {
  const c = await newBooking({ status: 'ACCEPTED' });
  const bad = await call('api', 'PUT', `/api/consultations/${c.id}/meeting`, tokens.doctor, { meetingUrl: 'https://zoom.us/j/1' });
  assert.equal(bad.status, 400);
  const r = await call('api', 'PUT', `/api/consultations/${c.id}/meeting`, tokens.doctor, { meetingUrl: ' meet.google.com/ABC-DEFG-HIJ ' });
  assert.equal(r.status, 200);
  assert.equal(r.body.meetingUrl, LINK);
  assert.equal(r.body.meetingLinkStatus, null, 'الحفظ ليس دليلًا على الإرسال');
});

test('4+5) الإرسال عبر WhatsApp API لرقم المريض، والرابط يظهر للأهل', { skip }, async () => {
  const c = await newBooking({ status: 'ACCEPTED' });
  const before = wa.messages.length;
  const r = await call('api', 'POST', `/api/consultations/${c.id}/meeting/send`, tokens.doctor, { meetingUrl: LINK });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.whatsapp, { mode: 'api', ok: true });
  assert.equal(r.body.consultation.meetingLinkStatus, 'SENT');
  assert.equal(r.body.consultation.meetingLinkSentUrl, LINK);
  assert.ok(r.body.consultation.meetingLinkSentAt);

  assert.equal(wa.messages.length - before, 1);
  const msg = wa.messages.at(-1);
  assert.equal(msg.url, '/v21.0/1234567890/messages');
  assert.equal(msg.auth, 'Bearer wa-test-token');
  assert.equal(msg.body.to, '962791234567');
  assert.equal(msg.body.template.name, 'meeting_link');
  const params = msg.body.template.components[0].parameters.map((p) => p.text);
  assert.equal(params[0], 'أم أحمد');
  assert.equal(params[1], 'د. سارة');
  assert.match(params[2], /2026|2027/);
  assert.equal(params[3], LINK);

  const mine = await call('api', 'GET', '/api/consultations/mine', tokens.parent);
  const row = mine.body.find((x) => x.id === c.id);
  assert.equal(row.meetingUrl, LINK);
});

test('7) تعديل الرابط يعيد الحالة، وإعادة الإرسال تعمل، ولا تكرار بدون طلب', { skip }, async () => {
  const c = await newBooking({ status: 'ACCEPTED' });
  await call('api', 'POST', `/api/consultations/${c.id}/meeting/send`, tokens.doctor, { meetingUrl: LINK });
  await wait(COOLDOWN + 50);
  const n0 = wa.messages.length;
  // نفس الرابط بدون resend: لا رسالة جديدة
  const again = await call('api', 'POST', `/api/consultations/${c.id}/meeting/send`, tokens.doctor, {});
  assert.equal(again.body.whatsapp.alreadySent, true);
  assert.equal(wa.messages.length, n0);
  // إعادة الإرسال الصريحة
  const resend = await call('api', 'POST', `/api/consultations/${c.id}/meeting/send`, tokens.doctor, { resend: true });
  assert.equal(resend.body.whatsapp.ok, true);
  assert.equal(wa.messages.length, n0 + 1);
  // تعديل الرابط: الحالة تعود «لم يُرسل»
  const edited = await call('api', 'PUT', `/api/consultations/${c.id}/meeting`, tokens.doctor, { meetingUrl: LINK2 });
  assert.equal(edited.body.meetingUrl, LINK2);
  assert.equal(edited.body.meetingLinkStatus, null);
  await wait(COOLDOWN + 50);
  const sent2 = await call('api', 'POST', `/api/consultations/${c.id}/meeting/send`, tokens.doctor, {});
  assert.equal(sent2.body.consultation.meetingLinkSentUrl, LINK2);
  assert.equal(wa.messages.at(-1).body.template.components[0].parameters[3].text, LINK2);
});

test('8) فشل WhatsApp: الرابط محفوظ، الحالة FAILED، وإعادة المحاولة تنجح', { skip }, async () => {
  const c = await newBooking({ status: 'ACCEPTED' });
  wa.fail = true;
  const r = await call('api', 'POST', `/api/consultations/${c.id}/meeting/send`, tokens.doctor, { meetingUrl: LINK });
  wa.fail = false;
  assert.equal(r.status, 200);
  assert.equal(r.body.whatsapp.ok, false);
  assert.ok(r.body.whatsapp.error);
  assert.equal(r.body.consultation.meetingUrl, LINK);
  assert.equal(r.body.consultation.meetingLinkStatus, 'FAILED');
  assert.equal(r.body.consultation.meetingLinkSentAt, null);
  await wait(COOLDOWN + 50);
  const retry = await call('api', 'POST', `/api/consultations/${c.id}/meeting/send`, tokens.doctor, {});
  assert.equal(retry.body.whatsapp.ok, true);
  assert.equal(retry.body.consultation.meetingLinkStatus, 'SENT');
});

test('منع الإرسال المكرر: ضغطات متزامنة = رسالة واحدة', { skip }, async () => {
  const c = await newBooking({ status: 'ACCEPTED' });
  await call('api', 'PUT', `/api/consultations/${c.id}/meeting`, tokens.doctor, { meetingUrl: LINK });
  wa.delayMs = 150;
  const n0 = wa.messages.length;
  const results = await Promise.all(
    [1, 2, 3].map(() => call('api', 'POST', `/api/consultations/${c.id}/meeting/send`, tokens.doctor, { resend: true }))
  );
  wa.delayMs = 0;
  assert.equal(wa.messages.length - n0, 1);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 429).length, 2);
});

test('9) غير المصرّح لهم لا يستطيعون تعديل الرابط أو إرساله', { skip }, async () => {
  const c = await newBooking({ status: 'ACCEPTED' });
  for (const who of ['parent', 'otherdoctor']) {
    const put = await call('api', 'PUT', `/api/consultations/${c.id}/meeting`, tokens[who], { meetingUrl: LINK });
    assert.equal(put.status, 403, who);
    const send = await call('api', 'POST', `/api/consultations/${c.id}/meeting/send`, tokens[who], { meetingUrl: LINK });
    assert.equal(send.status, 403, who);
  }
  const noAuth = await call('api', 'POST', `/api/consultations/${c.id}/meeting/send`, null, { meetingUrl: LINK });
  assert.equal(noAuth.status, 401);
  // الأدمن مسموح وفق الصلاحيات الحالية
  const admin = await call('api', 'PUT', `/api/consultations/${c.id}/meeting`, tokens.admin, { meetingUrl: LINK });
  assert.equal(admin.status, 200);
});

test('10) الدفع والحالات وتغيير الموعد لا تتأثر، والرابط لا يضيع', { skip }, async () => {
  const c = await newBooking();
  // تأكيد الدفع من صلاحية الأدمن فقط كما كان
  const forbidden = await call('api', 'PUT', `/api/consultations/${c.id}/status`, tokens.doctor, { status: 'PAYMENT_CONFIRMED' });
  assert.equal(forbidden.status, 403);
  // الإرسال للحجز غير المقبول ممنوع
  const early = await call('api', 'POST', `/api/consultations/${c.id}/meeting/send`, tokens.doctor, { meetingUrl: LINK });
  assert.equal(early.status, 409);

  await call('api', 'PUT', `/api/consultations/${c.id}/status`, tokens.admin, { status: 'PAYMENT_CONFIRMED' });
  await call('api', 'PUT', `/api/consultations/${c.id}/status`, tokens.doctor, { status: 'ACCEPTED' });
  const sent = await call('api', 'POST', `/api/consultations/${c.id}/meeting/send`, tokens.doctor, { meetingUrl: LINK });
  assert.equal(sent.body.consultation.meetingLinkStatus, 'SENT');

  // تغيير الموعد: الرابط يبقى، وحالة الإرسال تعود لأن الموعد تغيّر
  slotOffset += 1;
  const target = await prisma.specialistAvailability.create({
    data: {
      specialist: 'أخصائي/ة نطق',
      startAt: new Date(Date.now() + (3 + slotOffset) * 86400000),
      durationMinutes: 45,
      specialistProfileId: ids.profiles[0],
    },
  });
  ids.slots.push(target.id);
  const moved = await call('api', 'PUT', `/api/consultations/${c.id}/reschedule`, tokens.doctor, { availabilityId: target.id });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.status, 'CHANGED');
  assert.equal(moved.body.meetingUrl, LINK);
  assert.equal(moved.body.meetingLinkStatus, null);

  // اكتمال الجلسة: الرابط والبيانات تبقى
  const done = await call('api', 'PUT', `/api/consultations/${c.id}/status`, tokens.doctor, { status: 'COMPLETED' });
  assert.equal(done.body.meetingUrl, LINK);
  assert.equal(done.body.priceJod, 10);
  assert.equal(googleHits, 0);
});

test('بدون WhatsApp API: رابط wa.me برسالة جاهزة، ثم تسجيل «فُتح واتساب»', { skip }, async () => {
  const c = await newBooking({ status: 'ACCEPTED', phone: '+962 79 765 4321' });
  const r = await call('link', 'POST', `/api/consultations/${c.id}/meeting/send`, tokens.doctor, { meetingUrl: LINK });
  assert.equal(r.status, 200);
  assert.equal(r.body.whatsapp.mode, 'link');
  assert.equal(r.body.consultation.meetingLinkStatus, 'READY');
  const url = new URL(r.body.whatsapp.url);
  assert.equal(url.host, 'wa.me');
  assert.equal(url.pathname, '/962797654321');
  const text = url.searchParams.get('text');
  assert.match(text, /^مرحباً أم أحمد 🌷/);
  assert.match(text, /مع الأخصائي د\. سارة\./);
  assert.ok(text.includes(LINK));
  assert.match(text, /فريق أُعبر Uabber$/);

  const opened = await call('link', 'POST', `/api/consultations/${c.id}/meeting/opened`, tokens.doctor);
  assert.equal(opened.status, 200);
  assert.equal(opened.body.meetingLinkStatus, 'OPENED');
  assert.equal(opened.body.meetingLinkSentUrl, LINK);

  const noPhone = await newBooking({ status: 'ACCEPTED', phone: '12' });
  const np = await call('link', 'POST', `/api/consultations/${noPhone.id}/meeting/send`, tokens.doctor, { meetingUrl: LINK });
  assert.equal(np.status, 422);
  assert.equal(np.body.consultation.meetingUrl, LINK, 'الرابط محفوظ رغم عدم وجود رقم');
  assert.equal(googleHits, 0);
});
