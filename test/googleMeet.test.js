// اختبارات وحدة لخدمة Google Meet (طلبات Google وهمية عبر استبدال fetch).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.GOOGLE_REFRESH_TOKEN = 'test-refresh';
process.env.GOOGLE_MEET_POLL_MS = '1';

const meet = require('../src/utils/googleMeet');

const realFetch = global.fetch;
function mockFetch(handler) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', body: options.body };
    calls.push(call);
    if (call.url.includes('oauth2')) {
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    }
    return handler(call);
  };
  return calls;
}
test.afterEach(() => {
  global.fetch = realFetch;
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('deleteMeeting: يرسل DELETE مع sendUpdates=all ويعتبر 204 نجاحًا', async () => {
  const calls = mockFetch(() => new Response(null, { status: 204 }));
  const result = await meet.deleteMeeting('evt123');
  assert.deepEqual(result, { deleted: true });
  const del = calls.find((c) => c.method === 'DELETE');
  assert.match(del.url, /\/events\/evt123\?sendUpdates=all$/);
});

test('deleteMeeting: 404 و410 = محذوف مسبقًا (نجاح)', async () => {
  mockFetch(() => json({ error: { message: 'Not Found' } }, 404));
  assert.deepEqual(await meet.deleteMeeting('gone1'), { alreadyDeleted: true });
  mockFetch(() => json({ error: { message: 'Resource has been deleted' } }, 410));
  assert.deepEqual(await meet.deleteMeeting('gone2'), { alreadyDeleted: true });
});

test('deleteMeeting: أي خطأ آخر يُرمى مع eventId و status', async () => {
  mockFetch(() => json({ error: { message: 'Backend Error' } }, 500));
  await assert.rejects(meet.deleteMeeting('evt500'), (error) => {
    assert.equal(error.eventId, 'evt500');
    assert.equal(error.status, 500);
    assert.match(error.message, /GOOGLE_DELETE_FAILED: eventId=evt500 status=500/);
    return true;
  });
});

test('createMeeting: يرسل معرّف الحدث الثابت ويعيد الرابط', async () => {
  const calls = mockFetch((c) =>
    json({ id: JSON.parse(c.body).id, hangoutLink: 'https://meet.google.com/abc-defg-hij' })
  );
  const r = await meet.createMeeting({
    summary: 's', description: 'd', start: new Date(), minutes: 45, attendees: ['a@b.c', null], eventId: 'uabber1c1',
  });
  assert.deepEqual(r, { meetingUrl: 'https://meet.google.com/abc-defg-hij', eventId: 'uabber1c1' });
  const body = JSON.parse(calls.find((c) => c.method === 'POST' && !c.url.includes('oauth2')).body);
  assert.equal(body.id, 'uabber1c1');
  assert.equal(body.conferenceData.createRequest.requestId, 'uabber1c1');
  assert.deepEqual(body.attendees, [{ email: 'a@b.c' }]);
});

test('createMeeting: 409 لنفس المعرّف (إعادة محاولة) يستخدم الحدث الموجود', async () => {
  mockFetch((c) =>
    c.method === 'POST'
      ? json({ error: { message: 'duplicate' } }, 409)
      : json({ id: 'dup1', status: 'confirmed', hangoutLink: 'https://meet.google.com/aaa-bbbb-ccc' })
  );
  const r = await meet.createMeeting({ summary: 's', start: new Date(), minutes: 30, eventId: 'dup1' });
  assert.equal(r.eventId, 'dup1');
  assert.equal(r.meetingUrl, 'https://meet.google.com/aaa-bbbb-ccc');
});

test('createMeeting: حدث بلا رابط بعد المحاولات يرمي خطأ يحمل eventId (للتنظيف)', async () => {
  mockFetch(() => json({ id: 'nolink1' }));
  await assert.rejects(
    meet.createMeeting({ summary: 's', start: new Date(), minutes: 30, eventId: 'nolink1' }),
    (error) => error.eventId === 'nolink1'
  );
});

test('newEventId: صيغة Google (a-v و0-9) وفريد', () => {
  const a = meet.newEventId(42);
  const b = meet.newEventId(42);
  assert.match(a, /^[a-v0-9]{5,1024}$/);
  assert.notEqual(a, b);
});
