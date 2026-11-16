// اختبارات وحدة: روابط Meet اليدوية، أرقام واتساب، ونص الرسالة.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const m = require('../src/utils/meetingLink');
const whatsapp = require('../src/services/whatsapp');

test('روابط Google Meet: الصحيحة فقط', () => {
  assert.equal(m.normalizeMeetUrl('https://meet.google.com/abc-defg-hij'), 'https://meet.google.com/abc-defg-hij');
  assert.equal(m.normalizeMeetUrl(' meet.google.com/ABC-DEFG-HIJ '), 'https://meet.google.com/abc-defg-hij');
  assert.equal(m.normalizeMeetUrl('https://meet.google.com/abc-defg-hij?authuser=1'), 'https://meet.google.com/abc-defg-hij?authuser=1');
  for (const bad of ['', 'https://zoom.us/j/1', 'http://meet.google.com/abc-defg-hij', 'https://meet.google.com/abc', 'https://evil.com/meet.google.com/abc-defg-hij', 'javascript:alert(1)']) {
    assert.equal(m.normalizeMeetUrl(bad), null, bad);
  }
});

test('أرقام واتساب بالصيغة الدولية', () => {
  assert.equal(m.whatsappPhone('0791234567'), '962791234567');
  assert.equal(m.whatsappPhone('+962 79 123 4567'), '962791234567');
  assert.equal(m.whatsappPhone('00962791234567'), '962791234567');
  assert.equal(m.whatsappPhone('791234567'), '962791234567');
  assert.equal(m.whatsappPhone('+966501234567'), '966501234567');
  assert.equal(m.whatsappPhone('123'), null);
  assert.equal(m.whatsappPhone(null), null);
});

test('نص الرسالة مطابق للنموذج', () => {
  const text = m.buildMeetingMessage({
    patientName: 'أحمد',
    specialistName: 'د. سارة',
    date: new Date('2026-11-20T15:00:00Z'),
    url: 'https://meet.google.com/abc-defg-hij',
  });
  const lines = text.split('\n');
  assert.equal(lines[0], 'مرحباً أحمد 🌷');
  assert.equal(lines[1], 'تم تجهيز رابط جلسة الاستشارة الخاصة بك مع الأخصائي د. سارة.');
  assert.match(lines[2], /^📅 موعد الجلسة: .*2026.*6:00/);
  assert.equal(lines[3], '🔗 رابط الدخول إلى الجلسة:');
  assert.equal(lines[4], 'https://meet.google.com/abc-defg-hij');
  assert.equal(lines[5], 'نتمنى لكم جلسة موفقة ❤️');
  assert.equal(lines[6], 'فريق أُعبر Uabber');
});

test('رابط wa.me مع نص مُرمّز', () => {
  const url = whatsapp.clickToChatUrl('962791234567', 'مرحباً\nرابط');
  assert.equal(url, `https://wa.me/962791234567?text=${encodeURIComponent('مرحباً\nرابط')}`);
});

test('WhatsApp API غير مفعّل بدون المتغيرات الثلاثة', () => {
  const saved = { ...process.env };
  delete process.env.WHATSAPP_TOKEN;
  assert.equal(whatsapp.isWhatsAppApiConfigured(), false);
  process.env.WHATSAPP_TOKEN = 't';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1';
  assert.equal(whatsapp.isWhatsAppApiConfigured(), false); // القالب مطلوب
  process.env.WHATSAPP_TEMPLATE_NAME = 'x';
  assert.equal(whatsapp.isWhatsAppApiConfigured(), true);
  process.env = saved;
});

test('لا يوجد أي استدعاء لـ Google Calendar API في كود السيرفر', () => {
  const files = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (p.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(__dirname, '..', 'src'));
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(code, /googleapis\.com\/calendar|oauth2\.googleapis\.com|GOOGLE_REFRESH_TOKEN|GOOGLE_CLIENT_SECRET/, file);
  }
});
