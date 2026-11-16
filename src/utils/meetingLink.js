// روابط الاجتماعات اليدوية (Google Meet) ورسالة إرسالها للمريض.

const MEET_URL = /^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(\?[^\s]*)?$/i;

/** رابط Google Meet صالح؟ (مثال: https://meet.google.com/abc-defg-hij) */
function isValidMeetUrl(url) {
  return MEET_URL.test(String(url || '').trim());
}

/** توحيد الرابط: يقبل meet.google.com/xxx بدون https، ويحوّل الرمز لأحرف صغيرة. */
function normalizeMeetUrl(url) {
  let value = String(url || '').trim();
  if (/^meet\.google\.com\//i.test(value)) value = `https://${value}`;
  const m = MEET_URL.exec(value);
  if (!m) return null;
  return `https://meet.google.com/${m[1].toLowerCase()}${m[2] || ''}`;
}

/**
 * رقم واتساب بالصيغة الدولية بدون + (للأردن افتراضيًا):
 * 0791234567 → 962791234567، 791234567 → 962791234567، +962... → 962...
 */
function whatsappPhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^07\d{8}$/.test(digits)) return `962${digits.slice(1)}`;
  if (/^7\d{8}$/.test(digits)) return `962${digits}`;
  if (digits.length >= 10 && digits.length <= 15) return digits;
  return null;
}

/** تاريخ ووقت الجلسة بتوقيت الأردن. */
function formatSessionDate(date) {
  if (!date) return 'سيتم تأكيده';
  return new Intl.DateTimeFormat('ar-JO-u-nu-latn', {
    timeZone: process.env.APP_TIME_ZONE || 'Asia/Amman',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(date));
}

/** نص رسالة رابط الجلسة (للإرسال عبر واتساب). */
function buildMeetingMessage({ patientName, specialistName, date, url }) {
  return [
    `مرحباً ${patientName || ''} 🌷`.replace('  ', ' '),
    `تم تجهيز رابط جلسة الاستشارة الخاصة بك مع الأخصائي ${specialistName || ''}.`,
    `📅 موعد الجلسة: ${formatSessionDate(date)}`,
    '🔗 رابط الدخول إلى الجلسة:',
    url,
    'نتمنى لكم جلسة موفقة ❤️',
    'فريق أُعبر Uabber',
  ].join('\n');
}

module.exports = { isValidMeetUrl, normalizeMeetUrl, whatsappPhone, formatSessionDate, buildMeetingMessage };
