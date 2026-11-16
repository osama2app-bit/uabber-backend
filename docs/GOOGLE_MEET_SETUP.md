# تفعيل إنشاء اجتماعات Google Meet تلقائيًا

بعد التفعيل: لحظة قبول أي جلسة (من الأدمن أو الأخصائي) يُنشأ اجتماع Google Meet تلقائيًا،
ويظهر للأهل زر **«انضم للاجتماع»** وللأخصائي زر **«دخول الاجتماع»**، وتصل دعوة على
بريد الأهل والأخصائي في Google Calendar.

> بدون هذا الإعداد كل شيء يعمل أيضًا: الأخصائي أو الأدمن ينشئ اجتماعًا من
> meet.google.com ويلصق الرابط من زر **«رابط Google Meet»** في الحجز.

المدة التقريبية: 15 دقيقة، مرة واحدة فقط.

---

## 1) اختر حساب Google الذي «يملك» الاجتماعات
يُفضّل بريد خاص بالعيادة/التطبيق (مثل حساب Gmail للتطبيق). كل الاجتماعات ستُنشأ في
تقويم هذا الحساب، وهو منظّم الاجتماع.

## 2) أنشئ مشروعًا في Google Cloud
1. افتح https://console.cloud.google.com وسجّل الدخول بنفس الحساب.
2. من أعلى الصفحة: **Select a project ← New Project**، الاسم مثلًا `Uabber Meet` ← **Create**.
3. تأكد أن المشروع الجديد هو المختار في أعلى الصفحة.

## 3) فعّل Google Calendar API
1. من القائمة: **APIs & Services ← Library**.
2. ابحث عن **Google Calendar API** ← افتحها ← **Enable**.

## 4) شاشة الموافقة (OAuth consent screen)
1. **APIs & Services ← OAuth consent screen** (قد تظهر باسم **Google Auth Platform**).
2. اضغط **Get started** وعبّئ:
   - **App name**: `Uabber Meet`
   - **User support email**: بريدك
   - **Audience**: اختر **External**
   - **Contact information**: بريدك ← وافق على الشروط ← **Create**
3. من **Data Access** ← **Add or remove scopes** ← ابحث عن
   `https://www.googleapis.com/auth/calendar.events` وفعّله ← **Update** ← **Save**.
4. من **Audience** اضغط **Publish app** ← **Confirm** (لتصبح الحالة **In production**).

> ⚠️ هذه الخطوة مهمة: إذا بقي التطبيق في وضع **Testing** فإن المفتاح ينتهي بعد 7 أيام
> ويتوقف الإنشاء التلقائي. لا تحتاج «توثيق» Google لأنك الوحيد الذي سيسجّل الدخول؛
> ستظهر لك رسالة «Google hasn't verified this app» وهذا طبيعي.

## 5) أنشئ بيانات الدخول (Client ID)
1. **APIs & Services ← Credentials ← Create credentials ← OAuth client ID**.
2. **Application type**: اختر **Desktop app**، الاسم: `Uabber backend` ← **Create**.
3. انسخ **Client ID** و **Client secret** (احفظهما في مكان آمن، لا ترسلهما لأحد).

## 6) استخرج GOOGLE_REFRESH_TOKEN (على جهازك)
تحتاج Node.js 18 أو أحدث على جهازك.

في مجلد `uabber-backend` على جهازك، افتح **PowerShell** ونفّذ:

```powershell
$env:GOOGLE_CLIENT_ID="ضع Client ID هنا"
$env:GOOGLE_CLIENT_SECRET="ضع Client secret هنا"
npm run google:token
```

(على Mac/Linux:
`GOOGLE_CLIENT_ID="..." GOOGLE_CLIENT_SECRET="..." npm run google:token`)

1. سيُفتح المتصفح ← سجّل الدخول **بنفس حساب Google** من الخطوة 1.
2. إذا ظهرت «Google hasn't verified this app» ← **Advanced** ← **Go to Uabber Meet (unsafe)**.
3. وافق على صلاحية التقويم ← **Continue**.
4. ارجع لنافذة PowerShell، ستجد سطرًا مثل:
   ```
   GOOGLE_REFRESH_TOKEN=1//0g....
   ```
   انسخ القيمة كاملة.

## 7) أضف المفاتيح إلى Render
1. افتح خدمة `uabber-backend` في Render ← **Environment** ← **Add Environment Variable**:

   | المتغير | القيمة |
   |---|---|
   | `GOOGLE_CLIENT_ID` | من الخطوة 5 |
   | `GOOGLE_CLIENT_SECRET` | من الخطوة 5 |
   | `GOOGLE_REFRESH_TOKEN` | من الخطوة 6 |
   | `GOOGLE_CALENDAR_ID` | `primary` (اختياري) |

2. **Save Changes** ← انتظر حتى تنتهي إعادة النشر.

## 8) جرّب من التطبيق
بحساب الأدمن: **لوحة التحكم ← طلبات الاستشارات ← زر 🎥 «اختبار Google Meet»** في الأعلى.
- ✅ «الإعداد يعمل»: انتهى. من الآن كل جلسة تُقبل يُنشأ لها اجتماع تلقائيًا.
- ❌ ستظهر رسالة توضح المشكلة (راجع الجدول أدناه).

---

## حل المشاكل

| الرسالة | الحل |
|---|---|
| مفاتيح Google غير مضافة على السيرفر | أضف المتغيرات الثلاثة في Render وانتظر إعادة النشر |
| GOOGLE_REFRESH_TOKEN منتهي أو غير صحيح | تأكد أن التطبيق **In production** (الخطوة 4) ثم أعد الخطوة 6 |
| GOOGLE_CLIENT_ID أو GOOGLE_CLIENT_SECRET غير صحيح | انسخهما من جديد من Credentials |
| فعّل Google Calendar API | أعد الخطوة 3 لنفس المشروع |
| لم يصل refresh_token عند تشغيل السكربت | احذف صلاحية التطبيق من https://myaccount.google.com/permissions ثم أعد الخطوة 6 |

## ملاحظات
- لا ترسل Client secret أو Refresh token لأي شخص، ولا تضعهما في الكود أو GitHub.
- إذا تعطّل الإنشاء التلقائي لأي سبب، تبقى الجلسة مقبولة ويمكن إضافة الرابط يدويًا.
- عند تغيير موعد الجلسة يُحذف اجتماع الموعد القديم (ويصل للمدعوين إشعار إلغاء) ثم يُنشأ اجتماع جديد للموعد الجديد.

## دورة حياة الاجتماع (تلقائيًا)

| الحدث | ما يحدث في Google Calendar |
|---|---|
| قبول الجلسة / تأكيد الدفع | إنشاء اجتماع واحد فقط (حتى لو ضغط الأدمن والأخصائي معًا) |
| تغيير الموعد | حذف الاجتماع القديم مع إشعار إلغاء، ثم إنشاء اجتماع للموعد الجديد |
| رفض الجلسة أو إلغاؤها | حذف الاجتماع مع إشعار إلغاء للأهل والأخصائي |
| «إنشاء تلقائي» مرة أخرى | حذف الاجتماع السابق ثم إنشاء جديد |
| وضع رابط Meet يدوي | حذف الاجتماع التلقائي السابق (إن وجد) وحفظ الرابط اليدوي |

- فشل Google لا يوقف أي عملية حجز: الحالة تُحفظ دائمًا.
- إذا فشل حذف اجتماع، يُحفظ معرّفه في جدول `PendingMeetingDeletion` ويُعاد حذفه
  تلقائيًا كل ساعة، وعند الضغط على زر «اختبار Google Meet».
- سجلات السيرفر تبيّن أي فشل: `GOOGLE MEET CREATE FAILED` و `GOOGLE MEET DELETE FAILED eventId=...`.

## الاختبارات

```bash
npm test                                   # اختبارات الوحدة
TEST_DATABASE_URL=postgresql://... npm test   # + اختبارات التكامل (قاعدة اختبار فقط)
```
