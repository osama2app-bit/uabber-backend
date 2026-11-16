// إنشاء وحذف اجتماعات Google Meet عبر Google Calendar API.
//
// يعمل إذا ضُبطت متغيرات البيئة (حساب Google واحد يملك التقويم):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//   GOOGLE_CALENDAR_ID (اختياري، الافتراضي: primary)
// بدونها: يضع الأخصائي/الأدمن رابط Meet يدويًا.
//
// للاختبارات فقط: GOOGLE_OAUTH_TOKEN_URL و GOOGLE_CALENDAR_API_BASE
// لتوجيه الطلبات إلى خادم Google وهمي.
const crypto = require('crypto');

const tokenUrl = () => process.env.GOOGLE_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const apiBase = () => process.env.GOOGLE_CALENDAR_API_BASE || 'https://www.googleapis.com/calendar/v3';
const calendarPath = () =>
  `${apiBase()}/calendars/${encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || 'primary')}/events`;

function isMeetConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN
  );
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (_) {
    return {};
  }
}

async function accessToken() {
  const response = await fetch(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await readJson(response);
  if (!response.ok || !data.access_token) {
    throw new Error(`GOOGLE_AUTH_FAILED: ${data.error || response.status}`);
  }
  return data.access_token;
}

/**
 * معرّف حدث فريد بصيغة Google (أحرف a-v وأرقام فقط).
 * يتضمن رقم الحجز + وقت + جزء عشوائي، ويُحفظ في قاعدة البيانات قبل الإنشاء
 * حتى نعرف ما يجب حذفه لو انقطع الطلب في المنتصف.
 */
function newEventId(consultationId) {
  const random = crypto.randomInt(0, 32 ** 4).toString(32).padStart(4, '0');
  return `uabber${Number(consultationId).toString(32)}c${Date.now().toString(32)}${random}`;
}

const linkOf = (event) =>
  event?.hangoutLink ||
  event?.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;

/**
 * ينشئ حدثًا في التقويم مع رابط Meet ويدعو المشاركين بالبريد.
 * eventId (اختياري): معرّف ثابت للحدث، يمنع تكرار الإنشاء عند إعادة المحاولة.
 * يعيد { meetingUrl, eventId }.
 */
async function createMeeting({ summary, description, start, minutes, attendees = [], requestId, eventId }) {
  const token = await accessToken();
  const end = new Date(start.getTime() + minutes * 60000);

  const response = await fetch(`${calendarPath()}?conferenceDataVersion=1&sendUpdates=all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(eventId ? { id: eventId } : {}),
      summary,
      description,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      attendees: attendees.filter(Boolean).map((email) => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: String(requestId || eventId),
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    }),
  });

  let event = await readJson(response);
  if (response.status === 409 && eventId) {
    // الحدث بنفس المعرّف موجود مسبقًا (إعادة محاولة لنفس الطلب): نستخدمه
    event = await getEvent(token, eventId);
    if (!event || event.status === 'cancelled') {
      throw new Error(`GOOGLE_CALENDAR_FAILED: event ${eventId} already exists`);
    }
  } else if (!response.ok) {
    throw new Error(`GOOGLE_CALENDAR_FAILED: ${event.error?.message || response.status}`);
  }

  const createdId = event.id || eventId;
  let meetingUrl = linkOf(event);

  // أحيانًا يكون إنشاء الاجتماع «قيد التنفيذ»: نعيد قراءة الحدث بعد لحظات.
  for (let attempt = 0; !meetingUrl && attempt < 3; attempt += 1) {
    await new Promise((r) => setTimeout(r, Number(process.env.GOOGLE_MEET_POLL_MS || 1200)));
    meetingUrl = linkOf(await getEvent(token, createdId));
  }
  if (!meetingUrl) {
    const error = new Error(`GOOGLE_MEET_LINK_MISSING: event ${createdId}`);
    error.eventId = createdId; // الحدث أُنشئ فعلًا ويجب حذفه
    throw error;
  }
  return { meetingUrl, eventId: createdId };
}

async function getEvent(token, eventId) {
  const response = await fetch(`${calendarPath()}/${encodeURIComponent(eventId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.ok ? readJson(response) : null;
}

/**
 * حذف حدث من التقويم مع إرسال إشعار الإلغاء للمدعوين (sendUpdates=all).
 * 404/410 = محذوف مسبقًا ← نجاح.
 * أي خطأ آخر يُرمى (مع eventId و status) ولا يُتجاهل.
 * يعيد { deleted: true } أو { alreadyDeleted: true }.
 */
async function deleteMeeting(eventId) {
  if (!eventId) throw new Error('GOOGLE_DELETE_FAILED: missing eventId');
  const token = await accessToken();
  const response = await fetch(
    `${calendarPath()}/${encodeURIComponent(eventId)}?sendUpdates=all`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
  );
  if (response.ok) return { deleted: true };
  if (response.status === 404 || response.status === 410) return { alreadyDeleted: true };

  const data = await readJson(response);
  const error = new Error(
    `GOOGLE_DELETE_FAILED: eventId=${eventId} status=${response.status} ${data.error?.message || ''}`.trim()
  );
  error.eventId = eventId;
  error.status = response.status;
  throw error;
}

/** رابط Meet صالح؟ (للإدخال اليدوي) */
function isValidMeetUrl(url) {
  return /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(\?.*)?$/i.test(String(url || '').trim());
}

module.exports = { isMeetConfigured, createMeeting, deleteMeeting, isValidMeetUrl, newEventId };
