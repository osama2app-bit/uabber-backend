// اختبارات وحدة: جدول الدوام الأسبوعي وتوليد المواعيد.
const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/services/schedule');

const amman = (d) =>
  d.toLocaleString('en-GB', {
    timeZone: 'Asia/Amman',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

test('مثال: الأحد والثلاثاء والخميس 6-9 مساءً، جلسة 45 واستراحة 15', () => {
  const { schedule, error } = s.validateSchedule({
    weekdays: [0, 2, 4],
    startTime: '18:00',
    endTime: '21:00',
    sessionMinutes: 45,
    breakMinutes: 15,
    maxSessionsPerDay: 5,
  });
  assert.equal(error, undefined);
  assert.deepEqual(
    s.presentSchedule({ ...schedule, id: 1, specialistProfileId: 1 }).dailyTimes,
    [
      { start: '18:00', end: '18:45' },
      { start: '19:00', end: '19:45' },
      { start: '20:00', end: '20:45' },
    ]
  );
  const now = new Date('2026-11-16T10:00:00Z'); // الاثنين
  const starts = s.generateStarts(schedule, { from: now, until: new Date('2026-11-24T00:00:00Z'), now });
  assert.deepEqual(starts.map(amman), [
    'Tue 17/11, 18:00', 'Tue 17/11, 19:00', 'Tue 17/11, 20:00',
    'Thu 19/11, 18:00', 'Thu 19/11, 19:00', 'Thu 19/11, 20:00',
    'Sun 22/11, 18:00', 'Sun 22/11, 19:00', 'Sun 22/11, 20:00',
  ]);
});

test('الحد اليومي يقيّد عدد الجلسات', () => {
  const daily = s.dailySessionStarts({ startMinutes: 9 * 60, endMinutes: 17 * 60, sessionMinutes: 45, breakMinutes: 15, maxSessionsPerDay: 2 });
  assert.equal(daily.length, 2);
});

test('لا مواعيد بعد نهاية الاشتراك أو في الماضي', () => {
  const { schedule } = s.validateSchedule({ weekdays: [0, 1, 2, 3, 4, 5, 6], startTime: '10:00', endTime: '12:00', sessionMinutes: 60, maxSessionsPerDay: 2 });
  const now = new Date('2026-11-16T09:30:00Z'); // 11:30 بتوقيت عمّان
  const profile = { subscriptionExpiry: new Date('2026-11-18T07:30:00Z') }; // 10:30 عمّان يوم 18
  const window = s.generationWindow(schedule, profile, now);
  const starts = s.generateStarts(schedule, { ...window, now });
  // اليوم: 10:00 و11:00 في الماضي/جارٍ → لا. يوم 17: 10 و11. يوم 18: 10:00 تنتهي 11:00 بعد الاشتراك → لا
  assert.deepEqual(starts.map(amman), ['Tue 17/11, 10:00', 'Tue 17/11, 11:00']);
  // بدون اشتراك فعّال: لا شيء
  const none = s.generationWindow(schedule, { subscriptionExpiry: null }, now);
  assert.equal(s.generateStarts(schedule, { ...none, now }).length, 0);
});

test('التحقق من المدخلات', () => {
  const base = { weekdays: [1], startTime: '18:00', endTime: '21:00', sessionMinutes: 45, breakMinutes: 15, maxSessionsPerDay: 3 };
  assert.ok(s.validateSchedule({ ...base, weekdays: [] }).error);
  assert.ok(s.validateSchedule({ ...base, weekdays: [7] }).error);
  assert.ok(s.validateSchedule({ ...base, endTime: '17:00' }).error);
  assert.ok(s.validateSchedule({ ...base, sessionMinutes: 5 }).error);
  assert.ok(s.validateSchedule({ ...base, breakMinutes: -1 }).error);
  assert.ok(s.validateSchedule({ ...base, maxSessionsPerDay: 0 }).error);
  assert.ok(s.validateSchedule({ ...base, endTime: '18:30' }).error);
  assert.ok(s.validateSchedule({ ...base, timeZone: 'Mars/Base' }).error);
  assert.ok(s.validateSchedule({ ...base, validFrom: '2026-12-10', validUntil: '2026-12-01' }).error);
  assert.equal(s.validateSchedule(base).error, undefined);
});

test('التوقيت الصيفي: التحويل يحافظ على الساعة المحلية', () => {
  // نيويورك: تغيير التوقيت في 8 مارس 2026
  const before = s.zonedTimeToUtc({ year: 2026, month: 3, day: 7 }, 18 * 60, 'America/New_York');
  const after = s.zonedTimeToUtc({ year: 2026, month: 3, day: 9 }, 18 * 60, 'America/New_York');
  assert.equal(before.toISOString(), '2026-03-07T23:00:00.000Z');
  assert.equal(after.toISOString(), '2026-03-09T22:00:00.000Z');
});
