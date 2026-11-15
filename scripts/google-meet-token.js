#!/usr/bin/env node
// يستخرج GOOGLE_REFRESH_TOKEN لإنشاء اجتماعات Google Meet تلقائيًا.
//
// الاستخدام (على جهازك، مرة واحدة):
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google-meet-token.js
// في Windows PowerShell:
//   $env:GOOGLE_CLIENT_ID="..."; $env:GOOGLE_CLIENT_SECRET="..."; node scripts/google-meet-token.js
//
// سيُفتح رابط تسجيل الدخول بـ Google، وبعد الموافقة يطبع الـ refresh token.
// انسخه إلى Render كمتغير GOOGLE_REFRESH_TOKEN. لا ترسله لأحد.

const http = require('http');
const { exec } = require('child_process');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = Number(process.env.PORT || 53682);
const REDIRECT = `http://127.0.0.1:${PORT}/oauth2callback`;
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌ ضع GOOGLE_CLIENT_ID و GOOGLE_CLIENT_SECRET أولًا (راجع docs/GOOGLE_MEET_SETUP.md)\n');
  process.exit(1);
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // يضمن إرجاع refresh token
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error || !code) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`فشل تسجيل الدخول: ${error || 'no code'}`);
    console.error('\n❌ فشل تسجيل الدخول:', error);
    server.close();
    return;
  }

  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT,
        grant_type: 'authorization_code',
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.refresh_token) {
      throw new Error(data.error_description || data.error || 'لم يصل refresh_token');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2 dir="rtl">✅ تم. ارجع إلى نافذة الأوامر وانسخ GOOGLE_REFRESH_TOKEN.</h2>');
    console.log('\n✅ تم بنجاح. أضف هذا المتغير في Render (Environment):\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${data.refresh_token}\n`);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('حدث خطأ، راجع نافذة الأوامر');
    console.error('\n❌', e.message);
  } finally {
    server.close();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\nافتح هذا الرابط وسجّل الدخول بحساب Google الذي سيملك الاجتماعات:\n');
  console.log(authUrl + '\n');
  const opener =
    process.platform === 'win32' ? `start "" "${authUrl}"` :
    process.platform === 'darwin' ? `open "${authUrl}"` : `xdg-open "${authUrl}"`;
  exec(opener, () => {});
});
