// جدول الدوام الأسبوعي للأخصائي وتوليد المواعيد منه.
//
// مثال: الأحد والثلاثاء والخميس من 18:00 إلى 21:00، جلسة 45 دقيقة واستراحة 15:
//   18:00–18:45، 19:00–19:45، 20:00–20:45
// كل موعد صف مستقل بتاريخه، فحجز موعد يوم أحد لا يغلق أيام الأحد التالية.

const DEFAULT_TZ = 'Asia/Amman';
const MAX_DAYS_AHEAD = 120; // سقف التوليد للأمام
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// المنطقة الزمنية (بدون مكتبات)
// ---------------------------------------------------------------------------

function zoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** فرق المنطقة الزمنية عن UTC (بالمللي ثانية) في لحظة معينة. */
function zoneOffsetMs(date, timeZone) {
  const p = zoneParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** تاريخ ووقت محليان في منطقة زمنية → لحظة UTC (يراعي التوقيت الصيفي). */
function zonedTimeToUtc({ year, month, day }, minutes, timeZone) {
  const guess = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  let result = guess - zoneOffsetMs(new Date(guess), timeZone);
  // تصحيح ثانٍ عند الانتقال للتوقيت الصيفي/الشتوي
  result = guess - zoneOffsetMs(new Date(result), timeZone);
  return new Date(result);
}

/** التاريخ المحلي (يوم/شهر/سنة) للحظة معينة. */
function localDate(date, timeZone) {
  const p = zoneParts(date, timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

function addDays(d, n) {
  const x = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate() };
}

const weekdayOf = (d) => new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
const dayKey = (d) => d.year * 10000 + d.month * 100 + d.day;

// ---------------------------------------------------------------------------
// التحقق والتوليد (دوال صافية قابلة للاختبار)
// ---------------------------------------------------------------------------

function parseClock(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

const clock = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** أوقات بداية الجلسات في يوم واحد (بالدقائق). */
function dailySessionStarts({ startMinutes, endMinutes, sessionMinutes, breakMinutes = 0, maxSessionsPerDay }) {
  const starts = [];
  for (
    let t = startMinutes;
    t + sessionMinutes <= endMinutes && starts.length < maxSessionsPerDay;
    t += sessionMinutes + breakMinutes
  ) {
    starts.push(t);
  }
  return starts;
}

/**
 * يتحقق من مدخلات الجدول ويعيد { schedule } أو { error }.
 * body: { weekdays, startTime "18:00", endTime "21:00", sessionMinutes, breakMinutes,
 *         maxSessionsPerDay, validFrom?, validUntil?, isActive?, timeZone? }
 */
function validateSchedule(body = {}) {
  const weekdays = [...new Set((Array.isArray(body.weekdays) ? body.weekdays : []).map(Number))].sort();
  if (weekdays.length === 0 || weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return { error: 'اختر يوم دوام واحدًا على الأقل' };
  }
  const startMinutes = parseClock(body.startTime);
  const endMinutes = parseClock(body.endTime);
  if (startMinutes == null || endMinutes == null || endMinutes <= startMinutes) {
    return { error: 'وقت بداية ونهاية الدوام غير صالح' };
  }
  const sessionMinutes = Number(body.sessionMinutes);
  if (!Number.isInteger(sessionMinutes) || sessionMinutes < 15 || sessionMinutes > 180) {
    return { error: 'مدة الجلسة يجب أن تكون بين 15 و180 دقيقة' };
  }
  const breakMinutes = Number(body.breakMinutes ?? 0);
  if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > 120) {
    return { error: 'مدة الاستراحة يجب أن تكون بين 0 و120 دقيقة' };
  }
  const maxSessionsPerDay = Number(body.maxSessionsPerDay);
  if (!Number.isInteger(maxSessionsPerDay) || maxSessionsPerDay < 1 || maxSessionsPerDay > 30) {
    return { error: 'الحد الأقصى للجلسات يوميًا بين 1 و30' };
  }
  const timeZone = String(body.timeZone || DEFAULT_TZ);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch (_) {
    return { error: 'المنطقة الزمنية غير صالحة' };
  }
  const parseDay = (v) => {
    if (v == null || v === '') return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  const validFrom = parseDay(body.validFrom);
  const validUntil = parseDay(body.validUntil);
  if (validFrom === undefined || validUntil === undefined) return { error: 'تاريخ الفترة غير صالح' };
  if (validFrom && validUntil && validUntil < validFrom) return { error: 'نهاية الفترة قبل بدايتها' };

  const schedule = {
    weekdays,
    startMinutes,
    endMinutes,
    sessionMinutes,
    breakMinutes,
    maxSessionsPerDay,
    timeZone,
    validFrom,
    validUntil,
    isActive: body.isActive !== false,
  };
  if (dailySessionStarts(schedule).length === 0) {
    return { error: 'ساعات الدوام أقصر من مدة جلسة واحدة' };
  }
  return { schedule };
}

/**
 * لحظات بداية الجلسات ضمن نافذة زمنية.
 * window: { from: Date, until: Date } — until = نهاية اشتراك الأخصائي أو validUntil.
 */
function generateStarts(schedule, { from, until, now = new Date() }) {
  const tz = schedule.timeZone || DEFAULT_TZ;
  const begin = new Date(Math.max(from.getTime(), now.getTime()));
  const cap = new Date(now.getTime() + MAX_DAYS_AHEAD * DAY_MS);
  const end = new Date(Math.min(until.getTime(), cap.getTime()));
  if (end <= begin) return [];

  const starts = [];
  const daily = dailySessionStarts(schedule);
  const lastDay = dayKey(localDate(end, tz));
  for (let d = localDate(begin, tz); dayKey(d) <= lastDay; d = addDays(d, 1)) {
    if (!schedule.weekdays.includes(weekdayOf(d))) continue;
    for (const minutes of daily) {
      const at = zonedTimeToUtc(d, minutes, tz);
      const finish = new Date(at.getTime() + schedule.sessionMinutes * 60000);
      if (at > begin && finish <= end) starts.push(at);
    }
  }
  return starts;
}

/** نافذة التوليد: من بداية الفترة (أو الآن) حتى أقرب: نهاية الفترة، نهاية الاشتراك. */
function generationWindow(schedule, profile, now = new Date()) {
  const ends = [new Date(now.getTime() + MAX_DAYS_AHEAD * DAY_MS)];
  if (schedule.validUntil) ends.push(new Date(new Date(schedule.validUntil).getTime() + DAY_MS));
  if (profile?.subscriptionExpiry) ends.push(new Date(profile.subscriptionExpiry));
  else ends.push(now); // بدون اشتراك فعّال: لا مواعيد جديدة
  const from = schedule.validFrom ? new Date(schedule.validFrom) : now;
  return { from, until: new Date(Math.min(...ends.map((e) => e.getTime()))) };
}

// ---------------------------------------------------------------------------
// قاعدة البيانات
// ---------------------------------------------------------------------------

const SLOT_SPECIALTY = {
  behavior: 'أخصائي/ة تعديل سلوك',
  speech: 'أخصائي/ة نطق',
};

/**
 * يولّد المواعيد المستقبلية لجدول أخصائي (آمن للتكرار):
 * - يحذف فقط المواعيد المستقبلية «المتاحة» المولّدة من الجدول وغير المحجوزة
 *   عند replaceFuture (تعديل الجدول) — الحجوزات المؤكدة لا تُمس.
 * - يتخطى أي وقت يتداخل مع موعد موجود (محجوز/يدوي) مع احتساب الاستراحة.
 * يعيد { created, removed, skipped }.
 */
async function syncScheduleSlots(prisma, profileId, { replaceFuture = false, now = new Date() } = {}) {
  const schedule = await prisma.specialistSchedule.findUnique({ where: { specialistProfileId: profileId } });
  const profile = await prisma.specialistProfile.findUnique({ where: { id: profileId } });
  if (!schedule || !profile) return { created: 0, removed: 0, skipped: 0 };

  let removed = 0;
  if (replaceFuture || !schedule.isActive) {
    const result = await prisma.specialistAvailability.deleteMany({
      where: {
        specialistProfileId: profileId,
        scheduleId: schedule.id,
        status: 'AVAILABLE',
        isAvailable: true,
        startAt: { gt: now },
        consultations: { none: {} },
      },
    });
    removed = result.count;
  }
  if (!schedule.isActive || profile.status !== 'APPROVED') {
    await prisma.specialistSchedule.update({ where: { id: schedule.id }, data: { lastGeneratedAt: now } });
    return { created: 0, removed, skipped: 0 };
  }

  const window = generationWindow(schedule, profile, now);
  const starts = generateStarts(schedule, { ...window, now });
  if (starts.length === 0) {
    await prisma.specialistSchedule.update({ where: { id: schedule.id }, data: { lastGeneratedAt: now } });
    return { created: 0, removed, skipped: 0 };
  }

  // تداخل مع مواعيد موجودة (أي حالة عدا الملغاة) مع احتساب الاستراحة
  const gap = (schedule.sessionMinutes + schedule.breakMinutes) * 60000;
  const existing = await prisma.specialistAvailability.findMany({
    where: {
      specialistProfileId: profileId,
      status: { not: 'CANCELLED' },
      startAt: { gt: new Date(starts[0].getTime() - gap), lt: new Date(starts[starts.length - 1].getTime() + gap) },
    },
    select: { startAt: true, durationMinutes: true },
  });
  const overlaps = (at) =>
    existing.some((e) => {
      const a0 = at.getTime();
      const a1 = a0 + schedule.sessionMinutes * 60000;
      const b0 = e.startAt.getTime();
      const b1 = b0 + e.durationMinutes * 60000;
      return a0 < b1 && b0 < a1;
    });
  const free = starts.filter((at) => !overlaps(at));

  const created = free.length
    ? (
        await prisma.specialistAvailability.createMany({
          data: free.map((startAt) => ({
            specialist: SLOT_SPECIALTY[profile.specialty] || profile.specialty,
            specialistProfileId: profileId,
            scheduleId: schedule.id,
            startAt,
            durationMinutes: schedule.sessionMinutes,
            isAvailable: true,
            status: 'AVAILABLE',
          })),
          skipDuplicates: true,
        })
      ).count
    : 0;

  await prisma.specialistSchedule.update({ where: { id: schedule.id }, data: { lastGeneratedAt: now } });
  return { created, removed, skipped: starts.length - created };
}

/** توليد دوري لكل الجداول الفعّالة (يمدّد المواعيد مع تمديد الاشتراك). */
async function syncAllSchedules(prisma, now = new Date()) {
  const schedules = await prisma.specialistSchedule.findMany({
    where: { isActive: true },
    select: { specialistProfileId: true },
  });
  let created = 0;
  for (const s of schedules) {
    try {
      created += (await syncScheduleSlots(prisma, s.specialistProfileId, { now })).created;
    } catch (error) {
      console.error(`SCHEDULE SYNC FAILED profile=${s.specialistProfileId}:`, error.message);
    }
  }
  return { schedules: schedules.length, created };
}

/** الجدول كما يُرسل للتطبيق. */
function presentSchedule(s) {
  if (!s) return null;
  return {
    id: s.id,
    specialistProfileId: s.specialistProfileId,
    weekdays: s.weekdays,
    startTime: clock(s.startMinutes),
    endTime: clock(s.endMinutes),
    sessionMinutes: s.sessionMinutes,
    breakMinutes: s.breakMinutes,
    maxSessionsPerDay: s.maxSessionsPerDay,
    timeZone: s.timeZone,
    validFrom: s.validFrom,
    validUntil: s.validUntil,
    isActive: s.isActive,
    lastGeneratedAt: s.lastGeneratedAt,
    dailyTimes: dailySessionStarts(s).map((m) => ({ start: clock(m), end: clock(m + s.sessionMinutes) })),
  };
}

module.exports = {
  DEFAULT_TZ,
  zonedTimeToUtc,
  localDate,
  parseClock,
  dailySessionStarts,
  validateSchedule,
  generateStarts,
  generationWindow,
  syncScheduleSlots,
  syncAllSchedules,
  presentSchedule,
};
