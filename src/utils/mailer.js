// إرسال البريد الإلكتروني (لرموز استعادة كلمة المرور).
// يعمل فقط إذا ضُبطت متغيرات SMTP في البيئة:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM
// مثال Gmail: SMTP_HOST=smtp.gmail.com SMTP_PORT=465 مع "App Password".
const nodemailer = require('nodemailer');

let transporter = null;

function isMailConfigured() {
  return Boolean(
    process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
  );
}

function getTransporter() {
  if (!isMailConfigured()) return null;
  if (transporter) return transporter;

  const port = Number(process.env.SMTP_PORT || 465);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
}

// المرسل يظهر باسم التطبيق: «أُعبر وأتعلّم <email>»
// (إذا كتبت MAIL_FROM بصيغة "الاسم <email>" تُستخدم كما هي)
function fromAddress() {
  const raw = (process.env.MAIL_FROM || process.env.SMTP_USER || '').trim();
  if (raw.includes('<')) return raw;
  const name = process.env.MAIL_FROM_NAME || 'أُعبر وأتعلّم';
  return { name, address: raw };
}

async function sendMail({ to, subject, text, html, attachments }) {
  const t = getTransporter();
  if (!t) throw new Error('MAIL_NOT_CONFIGURED');
  await t.sendMail({
    from: fromAddress(),
    to,
    subject,
    text,
    html,
    attachments,
  });
}

module.exports = { isMailConfigured, sendMail };
