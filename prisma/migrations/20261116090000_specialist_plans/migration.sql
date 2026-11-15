-- باقات الأخصائيين: 10 دنانير لشهر ونصف (45 يومًا)، 15 دينارًا لـ 3 أشهر.
-- تُحدَّث الباقات الافتراضية فقط (إذا لم يغيّر الأدمن اسمها)، ويمكن تعديلها لاحقًا من لوحة الأدمن.
UPDATE "SubscriptionPlan"
SET "name" = 'اشتراك أخصائي - شهر ونصف',
    "description" = 'ظهور ملفك واستقبال الحجوزات لمدة شهر ونصف',
    "price" = '10', "durationType" = 'days', "durationValue" = 45,
    "isFeatured" = false, "updatedAt" = CURRENT_TIMESTAMP
WHERE "audience" = 'specialist' AND "name" = 'اشتراك أخصائي - شهر';

UPDATE "SubscriptionPlan"
SET "name" = 'اشتراك أخصائي - 3 أشهر',
    "description" = 'ظهور ملفك واستقبال الحجوزات لمدة 3 أشهر',
    "price" = '15', "durationType" = 'months', "durationValue" = 3,
    "isFeatured" = true, "updatedAt" = CURRENT_TIMESTAMP
WHERE "audience" = 'specialist' AND "name" = 'اشتراك أخصائي - 6 أشهر';
