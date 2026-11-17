// إشعارات المستخدمين: إنشاء (مع منع التكرار)، جدولة التذكير قبل الموعد بخمس دقائق،
// إلغاء التذكير عند إلغاء/تغيير الموعد، والإرسال من السيرفر مع إعادة المحاولة.
// كل إشعار يُحفظ في UserNotification (سجل كامل يظهر داخل التطبيق أيضًا).
const realPrisma = require('../config/prisma');
const fcm = require('./fcm');
const { formatSessionDate } = require('../utils/meetingLink');

const REMINDER_MINUTES = 5;
const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3];
const ACTIVE = ['NEW', 'PAYMENT_CONFIRMED', 'ACCEPTED', 'CHANGED'];
// التذكير للحجوزات المؤكدة فقط (المقبولة أو المعدّل موعدها)
const CONFIRMED = ['ACCEPTED', 'CHANGED'];

function createNotifications({ prisma = realPrisma, sender = fcm, logger = console, now = () => new Date() } = {}) {
  /** إنشاء إشعار؛ التكرار بنفس dedupeKey يُتجاهل بأمان. */
  async function enqueue({ userId, type, title, body, consultationId = null, data = {}, scheduledAt, dedupeKey }) {
    if (!userId) return null;
    try {
      return await prisma.userNotification.create({
        data: {
          userId,
          type,
          title,
          body,
          consultationId,
          data: { type, consultationId, ...data },
          scheduledAt: scheduledAt || now(),
          dedupeKey,
        },
      });
    } catch (error) {
      if (error.code === 'P2002') return null; // موجود مسبقًا
      throw error;
    }
  }

  async function participants(consultationId) {
    const c = await prisma.consultation.findUnique({
      where: { id: consultationId },
      include: { specialistProfile: { select: { userId: true, displayName: true } } },
    });
    if (!c) return null;
    return {
      c,
      parentId: c.userId,
      specialistUserId: c.specialistProfile?.userId || null,
      specialistName: c.specialistProfile?.displayName || c.specialist,
      when: formatSessionDate(c.date),
    };
  }

  /** إلغاء التذكيرات المعلّقة لحجز (عند الإلغاء أو تغيير الموعد). */
  async function cancelReminders(consultationId) {
    const r = await prisma.userNotification.updateMany({
      where: { consultationId, type: 'reminder', status: { in: ['PENDING', 'SENDING'] } },
      data: { status: 'CANCELLED', lastError: 'appointment changed or cancelled' },
    });
    return r.count;
  }

  /** تذكير للطرفين قبل الموعد بخمس دقائق بالضبط. */
  async function scheduleReminders(p) {
    const { c } = p;
    if (!c.date || !CONFIRMED.includes(c.status)) return 0;
    const at = new Date(c.date.getTime() - REMINDER_MINUTES * 60000);
    if (c.date <= now()) return 0;
    const stamp = c.date.toISOString();
    let created = 0;
    for (const [userId, body] of [
      [p.parentId, `جلستك مع ${p.specialistName} تبدأ بعد ${REMINDER_MINUTES} دقائق (${p.when}).`],
      [p.specialistUserId, `جلستك مع ${c.userName || 'المريض'} تبدأ بعد ${REMINDER_MINUTES} دقائق (${p.when}).`],
    ]) {
      if (!userId) continue;
      const n = await enqueue({
        userId,
        type: 'reminder',
        title: 'تذكير بموعد الجلسة ⏰',
        body,
        consultationId: c.id,
        scheduledAt: at < now() ? now() : at,
        dedupeKey: `reminder:${c.id}:${stamp}:${userId}`,
        data: { role: userId === p.specialistUserId ? 'specialist' : 'parent' },
      });
      if (n) created += 1;
    }
    return created;
  }

  async function both(p, { type, title, parentBody, specialistBody, key }) {
    for (const [userId, body, role] of [
      [p.parentId, parentBody, 'parent'],
      [p.specialistUserId, specialistBody, 'specialist'],
    ]) {
      if (!userId || !body) continue;
      await enqueue({
        userId,
        type,
        title,
        body,
        consultationId: p.c.id,
        dedupeKey: `${type}:${p.c.id}:${key}:${userId}`,
        data: { role },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // أحداث الحجز
  // ---------------------------------------------------------------------------

  async function onBookingCreated(consultationId) {
    const p = await participants(consultationId);
    if (!p) return;
    await both(p, {
      type: 'booking_new',
      title: 'طلب حجز جديد',
      parentBody: null,
      specialistBody: `${p.c.userName || 'ولي أمر'} طلب جلسة ${p.when}. راجع الطلب لقبوله.`,
      key: 'created',
    });
  }

  async function onStatusChanged(consultationId, status) {
    const p = await participants(consultationId);
    if (!p) return;
    if (status === 'ACCEPTED' || status === 'CHANGED') {
      if (status === 'ACCEPTED') {
        await both(p, {
          type: 'booking_confirmed',
          title: 'تم تأكيد الحجز ✅',
          parentBody: `تم تأكيد جلستك مع ${p.specialistName} ${p.when}.`,
          specialistBody: `تم تأكيد جلسة ${p.c.userName || 'المريض'} ${p.when}.`,
          key: p.c.date?.toISOString() || 'nodate',
        });
      }
      await scheduleReminders(p);
    } else if (status === 'REJECTED' || status === 'CANCELLED') {
      await cancelReminders(p.c.id);
      const verb = status === 'REJECTED' ? 'رفض' : 'إلغاء';
      await both(p, {
        type: 'booking_cancelled',
        title: status === 'REJECTED' ? 'تم رفض الحجز' : 'تم إلغاء الموعد',
        parentBody: `تم ${verb} جلستك مع ${p.specialistName} ${p.when}.`,
        specialistBody: `تم ${verb} جلسة ${p.c.userName || 'المريض'} ${p.when}.`,
        key: status,
      });
    } else if (status === 'COMPLETED') {
      await cancelReminders(p.c.id);
    }
  }

  async function onRescheduled(consultationId) {
    const p = await participants(consultationId);
    if (!p) return;
    await cancelReminders(p.c.id);
    await both(p, {
      type: 'booking_changed',
      title: 'تم تغيير موعد الجلسة',
      parentBody: `الموعد الجديد لجلستك مع ${p.specialistName}: ${p.when}.`,
      specialistBody: `الموعد الجديد لجلسة ${p.c.userName || 'المريض'}: ${p.when}.`,
      key: p.c.date?.toISOString() || 'nodate',
    });
    await scheduleReminders(p);
  }

  // ---------------------------------------------------------------------------
  // الإرسال (يُستدعى دوريًا من مهام الخلفية)
  // ---------------------------------------------------------------------------

  async function stillValid(n) {
    if (n.type !== 'reminder' || !n.consultationId) return true;
    const c = await prisma.consultation.findUnique({ where: { id: n.consultationId } });
    if (!c || !ACTIVE.includes(c.status) || !c.date) return false;
    // التذكير يخص نفس الموعد (لم يتغير) ولم يبدأ الموعد بعد
    return n.dedupeKey.includes(c.date.toISOString()) && c.date > now();
  }

  async function deliver(n) {
    const devices = await prisma.deviceToken.findMany({ where: { userId: n.userId } });
    if (!sender.isFcmConfigured()) return { status: 'SKIPPED', error: 'FCM_NOT_CONFIGURED' };
    if (devices.length === 0) return { status: 'SKIPPED', error: 'NO_DEVICE' };
    let delivered = 0;
    let retryable = false;
    const errors = [];
    for (const device of devices) {
      const r = await sender.sendToDevice({
        token: device.token,
        title: n.title,
        body: n.body,
        data: { ...(n.data || {}), notificationId: n.id, route: 'consultation' },
      });
      if (r.ok) delivered += 1;
      else {
        errors.push(r.error);
        if (r.invalidToken) await prisma.deviceToken.deleteMany({ where: { id: device.id } });
        if (r.retryable) retryable = true;
      }
    }
    if (delivered > 0) return { status: 'SENT' };
    return { status: retryable ? 'RETRY' : 'FAILED', error: errors.join(' | ').slice(0, 500) };
  }

  /** يرسل الإشعارات المستحقة. آمن مع عدة نسخ من السيرفر (حجز ذرّي لكل إشعار). */
  async function processDue(limit = 50) {
    const t = now();
    // استعادة إشعارات علقت في SENDING (توقف السيرفر أثناء الإرسال)
    await prisma.userNotification.updateMany({
      where: { status: 'SENDING', updatedAt: { lt: new Date(t.getTime() - 5 * 60000) } },
      data: { status: 'PENDING' },
    });
    const due = await prisma.userNotification.findMany({
      where: { status: 'PENDING', scheduledAt: { lte: t } },
      orderBy: { scheduledAt: 'asc' },
      take: limit,
    });
    const summary = { sent: 0, skipped: 0, failed: 0, retried: 0, cancelled: 0 };
    for (const n of due) {
      const claim = await prisma.userNotification.updateMany({
        where: { id: n.id, status: 'PENDING' },
        data: { status: 'SENDING', attempts: { increment: 1 } },
      });
      if (claim.count !== 1) continue;
      try {
        if (!(await stillValid(n))) {
          await prisma.userNotification.update({ where: { id: n.id }, data: { status: 'CANCELLED', lastError: 'appointment no longer valid' } });
          summary.cancelled += 1;
          continue;
        }
        const r = await deliver(n);
        const attempts = n.attempts + 1;
        if (r.status === 'SENT') {
          await prisma.userNotification.update({ where: { id: n.id }, data: { status: 'SENT', sentAt: now(), lastError: null } });
          summary.sent += 1;
        } else if (r.status === 'RETRY' && attempts < MAX_ATTEMPTS) {
          const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
          await prisma.userNotification.update({
            where: { id: n.id },
            data: { status: 'PENDING', scheduledAt: new Date(now().getTime() + delay), lastError: r.error },
          });
          summary.retried += 1;
        } else {
          const status = r.status === 'SKIPPED' ? 'SKIPPED' : 'FAILED';
          await prisma.userNotification.update({ where: { id: n.id }, data: { status, lastError: r.error } });
          summary[status === 'SKIPPED' ? 'skipped' : 'failed'] += 1;
        }
      } catch (error) {
        logger.error(`NOTIFICATION ${n.id} FAILED:`, error.message);
        await prisma.userNotification.update({
          where: { id: n.id },
          data: { status: 'PENDING', scheduledAt: new Date(now().getTime() + RETRY_DELAYS_MS[0]), lastError: error.message },
        });
        summary.retried += 1;
      }
    }
    return summary;
  }

  return { enqueue, cancelReminders, scheduleReminders, onBookingCreated, onStatusChanged, onRescheduled, processDue };
}

const defaultNotifications = createNotifications();

/** غلاف آمن للأحداث: فشل الإشعارات لا يُفشل عمليات الحجز. */
function safe(fn) {
  return (...args) =>
    fn(...args).catch((error) => console.error('NOTIFICATION EVENT FAILED:', error.message));
}

module.exports = {
  createNotifications,
  REMINDER_MINUTES,
  processDue: (...a) => defaultNotifications.processDue(...a),
  onBookingCreated: safe(defaultNotifications.onBookingCreated),
  onStatusChanged: safe(defaultNotifications.onStatusChanged),
  onRescheduled: safe(defaultNotifications.onRescheduled),
};
