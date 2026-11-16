// دورة حياة اجتماعات Google Meet للحجوزات:
//   ensureMeeting  : إنشاء اجتماع للحجز مرة واحدة فقط (حتى مع طلبات متزامنة).
//   releaseMeeting : حذف اجتماع الحجز من Google (مع إشعار إلغاء للمدعوين) ثم تنظيف بياناته.
//   retryPendingDeletions : إعادة محاولة حذف الاجتماعات التي فشل حذفها سابقًا.
//
// مبادئ:
// - فشل Google لا يُفشل أي عملية حجز (القبول/الرفض/الإلغاء/تغيير الموعد).
// - لا يُمسح معرّف اجتماع قديم قبل حذفه من Google أو تسجيله في
//   PendingMeetingDeletion لإعادة المحاولة لاحقًا.
// - منع التكرار: قبل الإنشاء «نحجز» الحجز بقيمة pending:<eventId>:<time> في
//   meetingEventId عبر updateMany مشروط (طلب واحد فقط ينجح)، ثم نحفظ النتيجة
//   بشرط أن الحجز ما زال لنا.
const realPrisma = require('../config/prisma');
const realMeet = require('../utils/googleMeet');

const PENDING_PREFIX = 'pending:';
const CLAIM_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MINUTES = 45;
// لا ننشئ اجتماعات لحجوزات منتهية
const CLOSED_STATUSES = new Set(['REJECTED', 'CANCELLED', 'COMPLETED']);

function parsePending(value) {
  if (typeof value !== 'string' || !value.startsWith(PENDING_PREFIX)) return null;
  const [, eventId, at] = value.split(':');
  return { eventId, at: Number(at) || 0 };
}

function createMeetingLifecycle({
  prisma = realPrisma,
  meet = realMeet,
  logger = console,
  now = () => Date.now(),
} = {}) {
  const find = (id) =>
    prisma.consultation.findUnique({
      where: { id },
      include: { specialistProfile: { include: { user: { select: { email: true } } } } },
    });

  async function recordPendingDeletion(eventId, consultationId, reason, error) {
    const lastError = String(error?.message || error || '').slice(0, 500);
    await prisma.pendingMeetingDeletion.upsert({
      where: { eventId },
      create: { eventId, consultationId: consultationId || null, reason, lastError, attempts: 1 },
      update: { attempts: { increment: 1 }, lastError },
    });
  }

  /**
   * يحذف حدثًا من Google. يعيد:
   *  { ok: true }                      حُذف أو كان محذوفًا (404/410)
   *  { ok: false, tracked: true }      فشل الحذف وسُجّل لإعادة المحاولة
   *  { ok: false, tracked: false }     فشل الحذف وفشل التسجيل (لا تمسح المعرّف!)
   */
  async function deleteEvent(eventId, { consultationId, reason }) {
    try {
      if (!meet.isMeetConfigured()) throw new Error('GOOGLE_NOT_CONFIGURED');
      await meet.deleteMeeting(eventId);
      return { ok: true };
    } catch (error) {
      logger.error(
        `GOOGLE MEET DELETE FAILED eventId=${eventId} consultation=${consultationId} reason=${reason}: ${error.message}`
      );
      try {
        await recordPendingDeletion(eventId, consultationId, reason, error);
        return { ok: false, tracked: true };
      } catch (dbError) {
        logger.error(`PENDING MEETING DELETION NOT SAVED eventId=${eventId}: ${dbError.message}`);
        return { ok: false, tracked: false };
      }
    }
  }

  /**
   * يحذف اجتماع الحجز (إن وجد) ثم ينظّف meetingUrl/meetingEventId.
   * لا يرمي أخطاء Google أبدًا.
   */
  async function releaseMeeting(consultationId, { reason = 'release' } = {}) {
    const c = await prisma.consultation.findUnique({ where: { id: consultationId } });
    if (!c) return null;
    const stored = c.meetingEventId;

    if (!stored) {
      if (c.meetingUrl) {
        await prisma.consultation.updateMany({
          where: { id: c.id, meetingEventId: null, meetingUrl: c.meetingUrl },
          data: { meetingUrl: null },
        });
      }
      return find(c.id);
    }

    // اجتماع قيد الإنشاء (pending) أو منشأ: نحذف حدثه بنفس الطريقة
    const pending = parsePending(stored);
    const eventId = pending ? pending.eventId : stored;
    const result = await deleteEvent(eventId, { consultationId: c.id, reason });

    if (!result.ok && !result.tracked) {
      // لم نستطع الحذف ولا التسجيل: نُخفي الرابط فقط ونبقي المعرّف لتنظيفه لاحقًا
      await prisma.consultation.updateMany({
        where: { id: c.id, meetingEventId: stored },
        data: { meetingUrl: null },
      });
      return find(c.id);
    }

    // حُذف من Google أو سُجّل في قائمة إعادة الحذف: الآن آمن تنظيفه
    await prisma.consultation.updateMany({
      where: { id: c.id, meetingEventId: stored },
      data: { meetingUrl: null, meetingEventId: null },
    });
    return find(c.id);
  }

  /**
   * ينشئ اجتماع Meet للحجز إن كانت Google مفعّلة ولم يُنشأ بعد.
   * لا يرمي أخطاء Google أبدًا: يعيد الحجز كما هو عند الفشل.
   */
  async function ensureMeeting(consultationId) {
    let c = await find(consultationId);
    if (!meet.isMeetConfigured()) return c;
    if (!c || !c.date || c.meetingUrl || CLOSED_STATUSES.has(c.status)) return c;

    const expected = c.meetingEventId || null;
    if (expected) {
      const pending = parsePending(expected);
      if (!pending) return c; // اجتماع موجود بالفعل
      if (now() - pending.at < CLAIM_TTL_MS) return c; // طلب آخر ينشئه الآن
      // حجز قديم عالق (انقطع الطلب): نحذف أي حدث ربما أُنشئ ثم نعيد المحاولة
      const cleaned = await deleteEvent(pending.eventId, { consultationId: c.id, reason: 'stale-claim' });
      if (!cleaned.ok && !cleaned.tracked) return c;
    }

    const eventId = meet.newEventId(c.id);
    const claimValue = `${PENDING_PREFIX}${eventId}:${now()}`;
    const claim = await prisma.consultation.updateMany({
      where: { id: c.id, meetingUrl: null, meetingEventId: expected },
      data: { meetingEventId: claimValue },
    });
    if (claim.count !== 1) return find(c.id); // طلب متزامن سبقنا

    let created;
    try {
      created = await meet.createMeeting({
        summary: `استشارة ${c.specialist} - ${c.userName || ''}`,
        description: `جلسة عبر تطبيق أُعبر وأتعلّم\nالأخصائي: ${c.specialistProfile?.displayName || c.specialist}\nالمريض: ${c.userName || ''}`,
        start: c.date,
        minutes: c.durationMinutes || DEFAULT_MINUTES,
        attendees: [c.userEmail, c.specialistProfile?.user?.email],
        eventId,
        requestId: eventId,
      });
    } catch (error) {
      logger.error(`GOOGLE MEET CREATE FAILED consultation=${c.id} eventId=${eventId}: ${error.message}`);
      if (error.eventId) {
        // الحدث أُنشئ لكن بدون رابط: نحذفه حتى لا تبقى دعوة بلا اجتماع
        await deleteEvent(error.eventId, { consultationId: c.id, reason: 'create-incomplete' });
      }
      await prisma.consultation.updateMany({
        where: { id: c.id, meetingEventId: claimValue },
        data: { meetingEventId: null },
      });
      return find(c.id);
    }

    const saved = await prisma.consultation.updateMany({
      where: { id: c.id, meetingEventId: claimValue },
      data: { meetingUrl: created.meetingUrl, meetingEventId: created.eventId },
    });
    if (saved.count !== 1) {
      // تغيّر الحجز أثناء الإنشاء (رُفض/أُلغي/تغيّر موعده): هذا الاجتماع لم يعد صالحًا
      logger.warn?.(`GOOGLE MEET superseded consultation=${c.id} eventId=${created.eventId}`);
      await deleteEvent(created.eventId, { consultationId: c.id, reason: 'superseded' });
    }
    return find(c.id);
  }

  /** يعيد محاولة حذف الاجتماعات العالقة. يعيد { deleted, failed, remaining }. */
  async function retryPendingDeletions(limit = 20) {
    const summary = { deleted: 0, failed: 0, remaining: 0 };
    if (!meet.isMeetConfigured()) {
      summary.remaining = await prisma.pendingMeetingDeletion.count();
      return summary;
    }
    const rows = await prisma.pendingMeetingDeletion.findMany({
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    for (const row of rows) {
      try {
        await meet.deleteMeeting(row.eventId);
        await prisma.pendingMeetingDeletion.delete({ where: { id: row.id } });
        summary.deleted += 1;
      } catch (error) {
        summary.failed += 1;
        logger.error(`GOOGLE MEET DELETE RETRY FAILED eventId=${row.eventId}: ${error.message}`);
        await prisma.pendingMeetingDeletion.update({
          where: { id: row.id },
          data: { attempts: { increment: 1 }, lastError: String(error.message).slice(0, 500) },
        });
      }
    }
    summary.remaining = await prisma.pendingMeetingDeletion.count();
    return summary;
  }

  return { ensureMeeting, releaseMeeting, retryPendingDeletions, recordPendingDeletion, deleteEvent };
}

const defaultLifecycle = createMeetingLifecycle();

/** تنظيف دوري للاجتماعات العالقة (كل ساعة) عند تفعيل Google. */
function startMeetingCleanup(intervalMs = 60 * 60 * 1000) {
  const run = () =>
    defaultLifecycle
      .retryPendingDeletions()
      .catch((error) => console.error('MEETING CLEANUP ERROR:', error.message));
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = {
  createMeetingLifecycle,
  ...defaultLifecycle,
  startMeetingCleanup,
  parsePending,
  CLAIM_TTL_MS,
};
