// إنشاء اجتماعات Google Meet تلقائيًا عبر Google Calendar API.
//
// يعمل إذا ضُبطت متغيرات البيئة (حساب Google واحد يملك التقويم):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//   GOOGLE_CALENDAR_ID (اختياري، الافتراضي: primary)
// بدونها: يضع الأخصائي/الأدمن رابط Meet يدويًا.

function isMeetConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN
  );
}

async function accessToken() {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(`GOOGLE_AUTH_FAILED: ${data.error || response.status}`);
  }
  return data.access_token;
}

/**
 * ينشئ حدثًا في التقويم مع رابط Meet ويدعو المشاركين بالبريد.
 * يعيد { meetingUrl, eventId }.
 */
async function createMeeting({ summary, description, start, minutes, attendees = [], requestId }) {
  const token = await accessToken();
  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || 'primary');
  const end = new Date(start.getTime() + minutes * 60000);

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?conferenceDataVersion=1&sendUpdates=all`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary,
        description,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        attendees: attendees.filter(Boolean).map((email) => ({ email })),
        conferenceData: {
          createRequest: {
            requestId: String(requestId),
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      }),
    }
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`GOOGLE_CALENDAR_FAILED: ${data.error?.message || response.status}`);
  }
  const meetingUrl =
    data.hangoutLink ||
    data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;
  if (!meetingUrl) throw new Error('GOOGLE_MEET_LINK_MISSING');
  return { meetingUrl, eventId: data.id };
}

/** رابط Meet صالح؟ (للإدخال اليدوي) */
function isValidMeetUrl(url) {
  return /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(\?.*)?$/i.test(String(url || '').trim());
}

module.exports = { isMeetConfigured, createMeeting, isValidMeetUrl };
