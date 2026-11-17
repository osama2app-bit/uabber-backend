// تكامل: جدول الدوام الأسبوعي، توليد المواعيد، الحجز الآمن، والصلاحيات.
// TEST_DATABASE_URL=postgresql://... npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { DB_URL, startServer, fixtures } = require('./helpers/server');

const skip = DB_URL ? false : 'ضع TEST_DATABASE_URL لتشغيل اختبارات التكامل';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

let prisma;
let api;
let fx;
let admin;
let parent;
let parent2;

test.before(async () => {
  if (skip) return;
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  fx = fixtures(prisma, `sched${Date.now()}`);
  admin = await fx.user('admin', 'ADMIN');
  parent = await fx.user('parent');
  parent2 = await fx.user('parent2');
  api = await startServer();
});

test.after(async () => {
  if (skip) return;
  api.stop();
  await fx.cleanup();
  await prisma.$disconnect();
});

const amman = (iso) =>
  new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Amman', weekday: 'short', hour: '2-digit', minute: '2-digit' });

function bookingForm(slotId, name = 'ولي أمر') {
  const form = new FormData();
  form.append('userName', name);
  form.append('phone', '0791234567');
  form.append('availabilityId', String(slotId));
  form.append('receipt', new Blob([Buffer.from('fake-receipt')], { type: 'image/png' }), 'receipt.png');
  return form;
}

const slotsOf = (profileId) =>
  prisma.specialistAvailability.findMany({ where: { specialistProfileId: profileId }, orderBy: { startAt: 'asc' } });

test('الأخصائي يحفظ جدوله فتُولَّد المواعيد ضمن مدة الاشتراك فقط', { skip }, async () => {
  const doc = await fx.specialist('a', { days: 21 });
  const r = await api.call('PUT', '/api/schedules/mine', doc.token, {
    weekdays: [0, 2, 4], startTime: '18:00', endTime: '21:00',
    sessionMinutes: 45, breakMinutes: 15, maxSessionsPerDay: 5,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.schedule.dailyTimes.map((t) => t.start), ['18:00', '19:00', '20:00']);
  assert.ok(r.body.created >= 6 * 3 - 3, `created ${r.body.created}`);

  const slots = await slotsOf(doc.profile.id);
  assert.equal(slots.length, r.body.created);
  for (const s of slots) {
    const label = amman(s.startAt);
    assert.match(label, /^(Sun|Tue|Thu) (18|19|20):00$/, label);
    assert.ok(s.startAt <= doc.profile.subscriptionExpiry);
    assert.equal(s.durationMinutes, 45);
    assert.equal(s.status, 'AVAILABLE');
    assert.ok(s.scheduleId);
  }
  // مدة الجلسة المعروضة للأهالي تتبع الجدول
  const profile = await prisma.specialistProfile.findUnique({ where: { id: doc.profile.id } });
  assert.equal(profile.sessionMinutes, 45);
  // إعادة التوليد لا تكرر المواعيد
  const again = await api.call('POST', '/api/schedules/mine/generate', doc.token);
  assert.equal(again.body.created, 0);
  assert.equal((await slotsOf(doc.profile.id)).length, slots.length);
});

test('حجز موعد يوم أحد يغلق ذلك الأحد فقط، ولا يُحجز مرتين (طلبات متزامنة)', { skip }, async () => {
  const doc = await fx.specialist('b', { days: 30 });
  await api.call('PUT', '/api/schedules/mine', doc.token, {
    weekdays: [0], startTime: '18:00', endTime: '19:00', sessionMinutes: 45, breakMinutes: 15, maxSessionsPerDay: 1,
  });
  const sundays = await slotsOf(doc.profile.id);
  assert.ok(sundays.length >= 3);
  const [first, second] = sundays;

  const results = await Promise.all([
    api.call('POST', '/api/consultations', parent.token, bookingForm(first.id)),
    api.call('POST', '/api/consultations', parent2.token, bookingForm(first.id)),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(await prisma.consultation.count({ where: { availabilityId: first.id } }), 1);

  const after = await prisma.specialistAvailability.findUnique({ where: { id: first.id } });
  assert.equal(after.status, 'BOOKED');
  assert.equal(after.isAvailable, false);
  const nextSunday = await prisma.specialistAvailability.findUnique({ where: { id: second.id } });
  assert.equal(nextSunday.status, 'AVAILABLE', 'next Sunday still open');

  // الموعد المحجوز لا يظهر للأهالي، والتالي يظهر
  const pub = await api.call('GET', `/api/consultations/availability?specialistProfileId=${doc.profile.id}`, parent.token);
  const ids = pub.body.map((s) => s.id);
  assert.ok(!ids.includes(first.id));
  assert.ok(ids.includes(second.id));
});

test('تعديل الجدول لا يمس الحجوزات المؤكدة', { skip }, async () => {
  const doc = await fx.specialist('c', { days: 30 });
  await api.call('PUT', '/api/schedules/mine', doc.token, {
    weekdays: [1, 3], startTime: '10:00', endTime: '12:00', sessionMinutes: 60, breakMinutes: 0, maxSessionsPerDay: 2,
  });
  const before = await slotsOf(doc.profile.id);
  const booked = before[0];
  const b = await api.call('POST', '/api/consultations', parent.token, bookingForm(booked.id));
  assert.equal(b.status, 201);
  await api.call('PUT', `/api/consultations/${b.body.id}/status`, doc.token, { status: 'ACCEPTED' });

  // جدول جديد مختلف تمامًا
  const r = await api.call('PUT', '/api/schedules/mine', doc.token, {
    weekdays: [6], startTime: '16:00', endTime: '18:00', sessionMinutes: 60, breakMinutes: 0, maxSessionsPerDay: 2,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.removed, before.length - 1, 'only unbooked generated slots removed');

  const kept = await prisma.specialistAvailability.findUnique({ where: { id: booked.id } });
  assert.ok(kept, 'booked slot kept');
  assert.equal(kept.status, 'BOOKED');
  const consultation = await prisma.consultation.findUnique({ where: { id: b.body.id } });
  assert.equal(consultation.status, 'ACCEPTED');
  assert.equal(consultation.date.getTime(), booked.startAt.getTime());

  const after = (await slotsOf(doc.profile.id)).filter((s) => s.id !== booked.id);
  assert.ok(after.length > 0);
  for (const s of after) assert.match(amman(s.startAt), /^Sat (16|17):00$/);
});

test('حالات الموعد: إلغاء الحجز يعيده متاحًا، والاكتمال COMPLETED، والإتاحة اليدوية', { skip }, async () => {
  const doc = await fx.specialist('d', { days: 30 });
  await api.call('PUT', '/api/schedules/mine', doc.token, {
    weekdays: ALL_DAYS, startTime: '09:00', endTime: '11:00', sessionMinutes: 60, breakMinutes: 0, maxSessionsPerDay: 2,
  });
  const [s1, s2, s3] = await slotsOf(doc.profile.id);

  const b1 = await api.call('POST', '/api/consultations', parent.token, bookingForm(s1.id));
  await api.call('PUT', `/api/consultations/${b1.body.id}/status`, admin.token, { status: 'CANCELLED' });
  assert.equal((await prisma.specialistAvailability.findUnique({ where: { id: s1.id } })).status, 'AVAILABLE');

  const b2 = await api.call('POST', '/api/consultations', parent.token, bookingForm(s2.id));
  await api.call('PUT', `/api/consultations/${b2.body.id}/status`, doc.token, { status: 'COMPLETED' });
  assert.equal((await prisma.specialistAvailability.findUnique({ where: { id: s2.id } })).status, 'COMPLETED');

  // الأخصائي يجعل موعدًا غير متاح ثم يعيده
  const off = await api.call('PUT', `/api/consultations/availability/${s3.id}`, doc.token, { status: 'UNAVAILABLE' });
  assert.equal(off.status, 200);
  assert.equal(off.body.status, 'UNAVAILABLE');
  const pub = await api.call('GET', `/api/consultations/availability?specialistProfileId=${doc.profile.id}`, parent.token);
  assert.ok(!pub.body.some((s) => s.id === s3.id));
  const book = await api.call('POST', '/api/consultations', parent.token, bookingForm(s3.id));
  assert.equal(book.status, 409, 'unavailable slot cannot be booked');
  const on = await api.call('PUT', `/api/consultations/availability/${s3.id}`, doc.token, { isAvailable: true });
  assert.equal(on.body.status, 'AVAILABLE');

  // لا يمكن تغيير حالة موعد مكتمل/محجوز
  const locked = await api.call('PUT', `/api/consultations/availability/${s2.id}`, doc.token, { status: 'AVAILABLE' });
  assert.equal(locked.status, 409);
});

test('الموعد اليدوي يلتزم بساعات الدوام والحد اليومي', { skip }, async () => {
  const doc = await fx.specialist('e', { days: 30 });
  await api.call('PUT', '/api/schedules/mine', doc.token, {
    weekdays: ALL_DAYS, startTime: '09:00', endTime: '12:00', sessionMinutes: 60, breakMinutes: 0, maxSessionsPerDay: 2,
  });
  // خارج ساعات الدوام (15:00 بتوقيت عمّان بعد يومين)
  const day = new Date(Date.now() + 2 * 86400000);
  const ymd = day.toLocaleDateString('en-CA', { timeZone: 'Asia/Amman' });
  const outside = await api.call('POST', '/api/consultations/availability', doc.token, { startAt: `${ymd}T15:00:00+03:00` });
  assert.equal(outside.status, 400);
  assert.match(outside.body.message, /ساعات الدوام/);
  // داخل الساعات لكن اليوم ممتلئ (09:00 و10:00 مولّدان، الحد 2)
  const full = await api.call('POST', '/api/consultations/availability', doc.token, { startAt: `${ymd}T11:00:00+03:00` });
  assert.equal(full.status, 400);
  assert.match(full.body.message, /الأقصى للجلسات/);
});

test('بدون اشتراك فعّال لا تُولَّد مواعيد، ومدخلات الجدول تُتحقق', { skip }, async () => {
  const doc = await fx.specialist('f', { days: 0 });
  const r = await api.call('PUT', '/api/schedules/mine', doc.token, {
    weekdays: [1], startTime: '10:00', endTime: '12:00', sessionMinutes: 60, maxSessionsPerDay: 2,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.created, 0);
  const bad = await api.call('PUT', '/api/schedules/mine', doc.token, {
    weekdays: [1], startTime: '12:00', endTime: '10:00', sessionMinutes: 60, maxSessionsPerDay: 2,
  });
  assert.equal(bad.status, 400);
});

test('الأدمن يشاهد ويدير جداول كل الأخصائيين، وغيره ممنوع', { skip }, async () => {
  const doc = await fx.specialist('g', { days: 14 });
  const list = await api.call('GET', '/api/schedules', admin.token);
  assert.equal(list.status, 200);
  assert.ok(list.body.some((row) => row.specialistProfileId === doc.profile.id));

  const put = await api.call('PUT', `/api/schedules/${doc.profile.id}`, admin.token, {
    weekdays: [2], startTime: '17:00', endTime: '19:00', sessionMinutes: 45, breakMinutes: 15, maxSessionsPerDay: 2,
  });
  assert.equal(put.status, 200);
  assert.ok(put.body.created > 0);
  assert.equal(put.body.upcoming.AVAILABLE, put.body.created);

  assert.equal((await api.call('GET', '/api/schedules', doc.token)).status, 403);
  assert.equal((await api.call('PUT', `/api/schedules/${doc.profile.id}`, parent.token, {})).status, 403);
  assert.equal((await api.call('GET', '/api/schedules/mine', parent.token)).status, 404);
  // أخصائي آخر لا يعدّل مواعيد غيره
  const other = await fx.specialist('h', { days: 14 });
  const [slot] = await slotsOf(doc.profile.id);
  const forbidden = await api.call('PUT', `/api/consultations/availability/${slot.id}`, other.token, { status: 'UNAVAILABLE' });
  assert.equal(forbidden.status, 403);
});
