// إرسال رسائل واتساب.
//
// وضعان:
// 1) WhatsApp Cloud API (إرسال تلقائي من السيرفر) — يعمل فقط إذا ضُبطت:
//      WHATSAPP_TOKEN            رمز الوصول الدائم (System User) من Meta
//      WHATSAPP_PHONE_NUMBER_ID  معرّف رقم واتساب للأعمال
//      WHATSAPP_TEMPLATE_NAME    اسم قالب معتمد من Meta (رسائل المبادرة تتطلب قالبًا)
//      WHATSAPP_TEMPLATE_LANG    لغة القالب (الافتراضي ar)
//    القالب يجب أن يحتوي 4 متغيرات بالترتيب: {{1}} اسم المريض، {{2}} اسم الأخصائي،
//    {{3}} موعد الجلسة، {{4}} رابط الجلسة. (راجع docs/WHATSAPP_SETUP.md)
// 2) بدونها: رابط wa.me يفتح واتساب على جهاز الأخصائي والرسالة جاهزة،
//    والأخصائي يضغط «إرسال» بنفسه. لا يمكن للسيرفر التأكد من الإرسال في هذا الوضع.

const apiBase = () => process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com/v21.0';

function isWhatsAppApiConfigured() {
  return Boolean(
    process.env.WHATSAPP_TOKEN &&
      process.env.WHATSAPP_PHONE_NUMBER_ID &&
      process.env.WHATSAPP_TEMPLATE_NAME
  );
}

/** رابط «اضغط للمحادثة» مع نص جاهز. */
function clickToChatUrl(phone, text) {
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

/**
 * يرسل قالب رابط الجلسة عبر Cloud API.
 * يعيد { messageId } أو يرمي خطأ برسالة واضحة.
 */
async function sendMeetingTemplate({ to, patientName, specialistName, dateText, url }) {
  if (!isWhatsAppApiConfigured()) throw new Error('WHATSAPP_NOT_CONFIGURED');
  const response = await fetch(`${apiBase()}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: process.env.WHATSAPP_TEMPLATE_NAME,
        language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'ar' },
        components: [
          {
            type: 'body',
            parameters: [patientName, specialistName, dateText, url].map((text) => ({
              type: 'text',
              text: String(text || '-'),
            })),
          },
        ],
      },
    }),
  });
  let data = {};
  try {
    data = await response.json();
  } catch (_) {}
  if (!response.ok) {
    throw new Error(`WHATSAPP_SEND_FAILED: ${data.error?.message || response.status}`);
  }
  return { messageId: data.messages?.[0]?.id || null };
}

module.exports = { isWhatsAppApiConfigured, clickToChatUrl, sendMeetingTemplate };
