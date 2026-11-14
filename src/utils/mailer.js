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

async function sendMail({ to, subject, text, html }) {
  const t = getTransporter();
  if (!t) throw new Error('MAIL_NOT_CONFIGURED');
  await t.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
  });
}

module.exports = { isMailConfigured, sendMail };
