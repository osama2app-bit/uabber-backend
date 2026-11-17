// إرسال إشعارات الدفع عبر Firebase Cloud Messaging (HTTP v1) لأجهزة Android وiOS.
//
// يتطلب متغير البيئة FIREBASE_SERVICE_ACCOUNT: محتوى ملف حساب الخدمة (JSON)
// من Firebase Console ← Project settings ← Service accounts ← Generate new private key.
// يقبل JSON مباشرة أو مشفّرًا بـ base64. بدونه: لا إرسال (الإشعارات تبقى ظاهرة داخل التطبيق).
const crypto = require('crypto');

const tokenUrl = () => process.env.FCM_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const apiBase = () => process.env.FCM_API_BASE || 'https://fcm.googleapis.com';

let cachedAccount;
let cachedToken = null; // { value, expiresAt }

function serviceAccount() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) return null;
  if (cachedAccount && cachedAccount.raw === raw) return cachedAccount.value;
  let value = null;
  try {
    const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (parsed.project_id && parsed.client_email && parsed.private_key) value = parsed;
  } catch (_) {
    value = null;
  }
  cachedAccount = { raw, value };
  return value;
}

function isFcmConfigured() {
  return Boolean(serviceAccount());
}

const b64url = (input) => Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.value;
  const account = serviceAccount();
  if (!account) throw new Error('FCM_NOT_CONFIGURED');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: account.token_uri || tokenUrl(),
      iat: now,
      exp: now + 3600,
    })
  );
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(account.private_key.replace(/\\n/g, '\n'));
  const assertion = `${header}.${claims}.${b64url(signature)}`;

  const response = await fetch(account.token_uri || tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(`FCM_AUTH_FAILED: ${data.error || response.status}`);
  }
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

/**
 * يرسل إشعارًا لجهاز واحد.
 * يعيد { ok: true } أو { ok: false, invalidToken, retryable, error }.
 */
async function sendToDevice({ token, title, body, data = {} }) {
  const account = serviceAccount();
  if (!account) return { ok: false, retryable: false, error: 'FCM_NOT_CONFIGURED' };
  let bearer;
  try {
    bearer = await accessToken();
  } catch (error) {
    return { ok: false, retryable: true, error: error.message };
  }
  const stringData = Object.fromEntries(
    Object.entries(data).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])
  );
  const response = await fetch(`${apiBase()}/v1/projects/${account.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        data: stringData,
        android: {
          priority: 'high',
          notification: { channel_id: 'uabber_bookings', sound: 'default', click_action: 'FLUTTER_NOTIFICATION_CLICK' },
        },
        apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
      },
    }),
  }).catch((error) => ({ ok: false, status: 0, json: async () => ({ error: { message: error.message } }) }));

  if (response.ok) return { ok: true };
  const payload = await response.json().catch(() => ({}));
  const status = payload.error?.status || '';
  const code = payload.error?.details?.find?.((d) => d.errorCode)?.errorCode || '';
  const message = `${response.status} ${status} ${code} ${payload.error?.message || ''}`.trim();
  const invalidToken =
    response.status === 404 || code === 'UNREGISTERED' || (code === 'INVALID_ARGUMENT' && /token/i.test(message));
  if (response.status === 401) cachedToken = null;
  return {
    ok: false,
    invalidToken,
    retryable: !invalidToken && (response.status === 0 || response.status === 401 || response.status === 429 || response.status >= 500),
    error: message,
  };
}

module.exports = { isFcmConfigured, sendToDevice };
