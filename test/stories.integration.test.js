// تكامل: إدارة القصص والتسجيلات الصوتية (حالات النشر، الرفع، التحقق، الترتيب، الصلاحيات).
const test = require('node:test');
const assert = require('node:assert/strict');
const { DB_URL, startServer, fixtures } = require('./helpers/server');

const skip = DB_URL ? false : 'ضع TEST_DATABASE_URL لتشغيل اختبارات التكامل';

let prisma;
let api;
let fx;
let admin;
let user;
const created = [];

test.before(async () => {
  if (skip) return;
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  fx = fixtures(prisma, `story${Date.now()}`);
  admin = await fx.user('admin', 'ADMIN');
  user = await fx.user('user');
  api = await startServer();
});

test.after(async () => {
  if (skip) return;
  api.stop();
  await prisma.story.deleteMany({ where: { id: { in: created } } });
  await fx.cleanup();
  await prisma.$disconnect();
});

// ملف WAV صغير صالح (0.1 ثانية صمت)
function wav() {
  const samples = 800;
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  return b;
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function form(fields, files = {}) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, String(v));
  for (const [k, [buf, type, name]] of Object.entries(files)) f.append(k, new Blob([buf], { type }), name);
  return f;
}

const userTitles = async () => (await api.call('GET', '/api/stories', user.token)).body.map((s) => s.title);

test('القصص الحالية منقولة لقاعدة البيانات ومنشورة', { skip }, async () => {
  const r = await api.call('GET', '/api/stories', user.token);
  assert.equal(r.status, 200);
  for (const key of ['rabbit_carrot', 'blue_car', 'big_book']) {
    assert.ok(r.body.some((s) => s.legacyKey === key), key);
  }
});

test('إنشاء قصة مسودة بصورة وتسجيل، ولا تظهر للمستخدم حتى النشر', { skip }, async () => {
  const r = await api.call('POST', '/api/stories/admin', admin.token, form(
    { title: 'قصة الاختبار', text: 'ذهب الطفل إلى الحديقة ولعب بالكرة.', word: 'حديقة', audioDurationSec: 4 },
    { image: [png, 'image/png', 'cover.png'], audio: [wav(), 'audio/wav', 'voice.wav'] }
  ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  created.push(r.body.id);
  assert.equal(r.body.status, 'DRAFT');
  assert.match(r.body.imageUrl, /\/uploads\/stories\//);
  assert.match(r.body.audioUrl, /\/uploads\/stories-audio\/.*\.wav$/);
  assert.equal(r.body.audioDurationSec, 4);
  assert.ok(!(await userTitles()).includes('قصة الاختبار'));

  // الملف المرفوع قابل للتشغيل (متاح عبر الرابط)
  const audio = await fetch(r.body.audioUrl.replace(/^https?:\/\/[^/]+/, api.base));
  assert.equal(audio.status, 200);

  const pub = await api.call('PUT', `/api/stories/admin/${r.body.id}`, admin.token, { status: 'PUBLISHED' });
  assert.equal(pub.body.status, 'PUBLISHED');
  assert.ok(pub.body.publishedAt);
  assert.ok((await userTitles()).includes('قصة الاختبار'));

  for (const status of ['HIDDEN', 'ARCHIVED']) {
    await api.call('PUT', `/api/stories/admin/${r.body.id}`, admin.token, { status });
    assert.ok(!(await userTitles()).includes('قصة الاختبار'), status);
  }
  const all = await api.call('GET', '/api/stories/admin/all', admin.token);
  assert.equal(all.body.find((s) => s.id === r.body.id).status, 'ARCHIVED');
});

test('تعديل النص والصورة واستبدال التسجيل وحذفه دون إنشاء قصة جديدة', { skip }, async () => {
  const r = await api.call('POST', '/api/stories/admin', admin.token, form({ title: 'قصة للتعديل', text: 'نص أولي للقصة.', status: 'PUBLISHED' }));
  created.push(r.body.id);
  const before = (await api.call('GET', '/api/stories/admin/all', admin.token)).body.length;

  const edited = await api.call('PUT', `/api/stories/admin/${r.body.id}`, admin.token, form(
    { text: 'نص جديد بعد التعديل.', audioDurationSec: 7 },
    { audio: [wav(), 'audio/x-wav', 'new.wav'], image: [png, 'image/png', 'new.png'] }
  ));
  assert.equal(edited.status, 200);
  assert.equal(edited.body.id, r.body.id);
  assert.equal(edited.body.text, 'نص جديد بعد التعديل.');
  assert.equal(edited.body.title, 'قصة للتعديل');
  assert.ok(edited.body.audioUrl && edited.body.imageUrl);
  assert.equal(edited.body.audioDurationSec, 7);

  const user1 = (await api.call('GET', '/api/stories', user.token)).body.find((s) => s.id === r.body.id);
  assert.equal(user1.text, 'نص جديد بعد التعديل.', 'users see the update automatically');

  const noAudio = await api.call('DELETE', `/api/stories/admin/${r.body.id}/audio`, admin.token);
  assert.equal(noAudio.body.audioUrl, null);
  assert.equal(noAudio.body.audioDurationSec, null);
  const noImage = await api.call('PUT', `/api/stories/admin/${r.body.id}`, admin.token, { removeImage: true });
  assert.equal(noImage.body.imageUrl, null);
  assert.equal((await api.call('GET', '/api/stories/admin/all', admin.token)).body.length, before, 'no new story created');
});

test('التحقق من نوع وحجم الملفات والحقول', { skip }, async () => {
  const badType = await api.call('POST', '/api/stories/admin', admin.token, form(
    { title: 'ملف خطأ', text: 'نص القصة هنا.' },
    { image: [Buffer.from('hello'), 'text/plain', 'x.txt'] }
  ));
  assert.equal(badType.status, 400);
  assert.match(badType.body.message, /نوع الملف/);

  const audioAsImage = await api.call('POST', '/api/stories/admin', admin.token, form(
    { title: 'ملف خطأ', text: 'نص القصة هنا.' },
    { audio: [png, 'image/png', 'x.png'] }
  ));
  assert.equal(audioAsImage.status, 400);

  const huge = await api.call('POST', '/api/stories/admin', admin.token, form(
    { title: 'ملف كبير', text: 'نص القصة هنا.' },
    { audio: [Buffer.alloc(16 * 1024 * 1024), 'audio/mpeg', 'big.mp3'] }
  ));
  assert.equal(huge.status, 400);
  assert.match(huge.body.message, /كبير/);

  const bigImage = await api.call('POST', '/api/stories/admin', admin.token, form(
    { title: 'صورة كبيرة', text: 'نص القصة هنا.' },
    { image: [Buffer.alloc(6 * 1024 * 1024), 'image/jpeg', 'big.jpg'] }
  ));
  assert.equal(bigImage.status, 400);

  const noTitle = await api.call('POST', '/api/stories/admin', admin.token, form({ title: '', text: 'نص' }));
  assert.equal(noTitle.status, 400);
  const badStatus = await api.call('POST', '/api/stories/admin', admin.token, form({ title: 'عنوان', text: 'نص القصة هنا.', status: 'LIVE' }));
  assert.equal(badStatus.status, 400);
});

test('الترتيب يُحفظ ويظهر للمستخدم بنفس الترتيب', { skip }, async () => {
  const a = (await api.call('POST', '/api/stories/admin', admin.token, form({ title: 'ترتيب أ', text: 'نص القصة أ.', status: 'PUBLISHED' }))).body;
  const b = (await api.call('POST', '/api/stories/admin', admin.token, form({ title: 'ترتيب ب', text: 'نص القصة ب.', status: 'PUBLISHED' }))).body;
  created.push(a.id, b.id);
  const all = (await api.call('GET', '/api/stories/admin/all', admin.token)).body.map((s) => s.id);
  const order = [b.id, a.id, ...all.filter((id) => id !== a.id && id !== b.id)];
  const r = await api.call('PUT', '/api/stories/admin/reorder', admin.token, { ids: order });
  assert.equal(r.status, 200);
  const titles = await userTitles();
  assert.ok(titles.indexOf('ترتيب ب') < titles.indexOf('ترتيب أ'));
  assert.equal(titles[0], 'ترتيب ب');
  assert.equal((await api.call('PUT', '/api/stories/admin/reorder', admin.token, { ids: [a.id, a.id] })).status, 400);
});

test('الحذف، والصلاحيات للأدمن فقط', { skip }, async () => {
  const s = (await api.call('POST', '/api/stories/admin', admin.token, form({ title: 'للحذف', text: 'نص القصة للحذف.' }))).body;
  for (const [method, url] of [
    ['GET', '/api/stories/admin/all'],
    ['POST', '/api/stories/admin'],
    ['PUT', `/api/stories/admin/${s.id}`],
    ['PUT', '/api/stories/admin/reorder'],
    ['DELETE', `/api/stories/admin/${s.id}/audio`],
    ['DELETE', `/api/stories/admin/${s.id}`],
  ]) {
    assert.equal((await api.call(method, url, user.token, {})).status, 403, `${method} ${url}`);
  }
  assert.equal((await api.call('GET', '/api/stories', null)).status, 401);
  const del = await api.call('DELETE', `/api/stories/admin/${s.id}`, admin.token);
  assert.equal(del.status, 200);
  assert.equal(await prisma.story.count({ where: { id: s.id } }), 0);
  assert.equal((await api.call('DELETE', `/api/stories/admin/${s.id}`, admin.token)).status, 404);
});

test('نقل نص القصص المعدّل سابقًا من تعديلات الأدمن القديمة (مرة واحدة)', { skip }, async () => {
  process.env.DATABASE_URL = DB_URL;
  const { importLegacyStoryText } = require('../src/routes/stories.routes');
  const original = await prisma.story.findUnique({ where: { legacyKey: 'big_book' } });
  await prisma.appSetting.deleteMany({ where: { key: 'stories_legacy_text_import_v1' } });
  const override = await prisma.educationalContentOverride.create({
    data: {
      id: `test-story-override-${Date.now()}`,
      unitId: 'stories',
      targetKey: 'story_big_book',
      title: original.title,
      speechText: JSON.stringify({ text: 'نص معدّل من الأدمن سابقًا.', word: 'كتاب' }),
      isOverride: true,
      updatedById: admin.id,
    },
  });
  try {
    assert.ok((await importLegacyStoryText()) >= 1);
    const after = await prisma.story.findUnique({ where: { legacyKey: 'big_book' } });
    assert.equal(after.text, 'نص معدّل من الأدمن سابقًا.');
    assert.equal(after.word, 'كتاب');
    assert.equal(await importLegacyStoryText(), 0, 'runs once only');
  } finally {
    await prisma.educationalContentOverride.delete({ where: { id: override.id } });
    await prisma.story.update({ where: { id: original.id }, data: { text: original.text, word: original.word } });
  }
});
