// قوالب البريد الإلكتروني (HTML متوافق مع Gmail وOutlook وApple Mail).
// تصميم بالجداول وأنماط مضمّنة لأن برامج البريد لا تدعم CSS الحديث.
const path = require('path');

const APP_NAME = 'أُعبر وأتعلّم';
const BRAND = '#256D5A';
const BRAND_SOFT = '#E8FFF6';
const TEXT = '#1F2D3A';
const MUTED = '#60758A';
const PAGE_BG = '#F4F7F6';
const LOGO_BG = '#F1EBEB';
const FONT = "Tahoma, 'Segoe UI', Arial, sans-serif";

// الشعار مرفق داخل الرسالة (cid) حتى يظهر بدون روابط خارجية.
const LOGO_CID = 'uabber-logo@mail';
const logoAttachment = {
  filename: 'logo.png',
  path: path.join(__dirname, '..', '..', 'assets', 'email-logo.png'),
  cid: LOGO_CID,
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** الإطار العام لأي رسالة. */
function layout({ preheader, title, bodyHtml }) {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE_BG};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE_BG};">
  <tr>
    <td align="center" style="padding:28px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #E3EBE8;">
        <tr>
          <td align="center" style="background:${LOGO_BG};padding:26px 20px 18px;">
            <img src="cid:${LOGO_CID}" width="90" alt="${APP_NAME}" style="display:block;width:90px;height:auto;border:0;">
          </td>
        </tr>
        <tr>
          <td style="height:5px;line-height:5px;font-size:0;background:${BRAND};">&nbsp;</td>
        </tr>
        <tr>
          <td dir="rtl" style="padding:32px 32px 8px;font-family:${FONT};color:${TEXT};text-align:right;">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td dir="rtl" style="padding:18px 32px 26px;font-family:${FONT};text-align:center;border-top:1px solid #EEF2F1;">
            <p style="margin:0 0 4px;font-size:14px;font-weight:bold;color:${BRAND};">${APP_NAME}</p>
            <p style="margin:0;font-size:12px;line-height:1.7;color:${MUTED};">للتواصل والتعلّم<br>هذه رسالة تلقائية، يرجى عدم الرد عليها.</p>
            <p style="margin:10px 0 0;font-size:11px;color:#9AABB8;">© ${year} ${APP_NAME}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** رسالة رمز استعادة كلمة المرور. */
function passwordResetEmail({ name, code, minutes }) {
  const safeName = escapeHtml(name || '');
  const digits = String(code).split('');
  const codeCells = digits
    .map(
      (d) =>
        `<td style="padding:0 3px;"><div style="width:40px;height:54px;line-height:54px;background:${BRAND_SOFT};border:1px solid #BFE6D6;border-radius:12px;font-family:'Courier New',monospace;font-size:28px;font-weight:bold;color:${BRAND};text-align:center;">${d}</div></td>`
    )
    .join('');

  const bodyHtml = `
    <h1 style="margin:0 0 14px;font-size:22px;line-height:1.5;color:${TEXT};">إعادة تعيين كلمة المرور</h1>
    <p style="margin:0 0 10px;font-size:16px;line-height:1.8;">مرحبًا${safeName ? ` ${safeName}` : ''}،</p>
    <p style="margin:0 0 22px;font-size:16px;line-height:1.8;">تلقّينا طلبًا لإعادة تعيين كلمة المرور لحسابك. أدخل الرمز التالي في التطبيق لإكمال العملية:</p>
    <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" dir="ltr" style="margin:0 auto 12px;">
      <tr>${codeCells}</tr>
    </table>
    <p style="margin:0 0 26px;font-size:13px;color:${MUTED};text-align:center;">الرمز صالح لمدة <strong style="color:${TEXT};">${minutes} دقيقة</strong> ويُستخدم مرة واحدة فقط</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
      <tr>
        <td style="background:#FFF8E8;border-right:4px solid #E3A72F;border-radius:10px;padding:14px 16px;font-family:${FONT};font-size:14px;line-height:1.8;color:#6B5418;text-align:right;">
          <strong>لم تطلب ذلك؟</strong> تجاهل هذه الرسالة وستبقى كلمة مرورك كما هي.<br>
          لا تشارك هذا الرمز مع أي شخص، فريقنا لن يطلبه منك أبدًا.
        </td>
      </tr>
    </table>`;

  return {
    subject: `${code} رمز استعادة كلمة المرور - ${APP_NAME}`,
    text:
      `مرحبًا${name ? ` ${name}` : ''}،\n\n` +
      `رمز استعادة كلمة المرور في ${APP_NAME}: ${code}\n` +
      `الرمز صالح لمدة ${minutes} دقيقة ويُستخدم مرة واحدة.\n\n` +
      'إذا لم تطلب ذلك فتجاهل هذه الرسالة، ولا تشارك الرمز مع أحد.\n\n' +
      APP_NAME,
    html: layout({
      preheader: `رمزك هو ${code} — صالح لمدة ${minutes} دقيقة`,
      title: 'إعادة تعيين كلمة المرور',
      bodyHtml,
    }),
    attachments: [logoAttachment],
  };
}

module.exports = { APP_NAME, layout, passwordResetEmail, logoAttachment };
