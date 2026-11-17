-- CreateEnum
CREATE TYPE "StoryStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'HIDDEN', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Story" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "word" TEXT,
    "emoji" TEXT,
    "imageUrl" TEXT,
    "audioUrl" TEXT,
    "audioDurationSec" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "StoryStatus" NOT NULL DEFAULT 'DRAFT',
    "legacyKey" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Story_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Story_legacyKey_key" ON "Story"("legacyKey");

-- CreateIndex
CREATE INDEX "Story_status_sortOrder_idx" ON "Story"("status", "sortOrder");


-- القصص الست الموجودة في التطبيق سابقًا: تُنقل لقاعدة البيانات كما هي (منشورة)
INSERT INTO "Story" ("title", "text", "word", "emoji", "sortOrder", "status", "legacyKey", "publishedAt", "updatedAt") VALUES
  ('الأرنب والجزر', 'رأى الأرنب جزرة برتقالية في الحديقة. قال الأرنب: هذه جزرة. أكل الأرنب الجزرة وشعر بالسعادة.', 'جزرة', '🐰🥕', 1, 'PUBLISHED', 'rabbit_carrot', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('السيارة الزرقاء', 'ركب سامر السيارة الزرقاء مع بابا. السيارة الزرقاء تسير في الطريق، ثم تقف أمام البيت.', 'سيارة زرقاء', '🚙💙', 2, 'PUBLISHED', 'blue_car', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('القطة تحت الطاولة', 'اختبأت القطة الصغيرة تحت الطاولة. سألت ماما: أين القطة؟ القطة تحت الطاولة.', 'تحت الطاولة', '🐱▭', 3, 'PUBLISHED', 'cat_under_table', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('الكرة الحمراء', 'لعبت ليان بالكرة الحمراء. رمت الكرة إلى أخيها، ثم قالت: الكرة الحمراء جميلة.', 'كرة حمراء', '🔴⚽', 4, 'PUBLISHED', 'red_ball', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('الموزة الصفراء', 'أخذ الطفل موزة صفراء. قشر الموزة بهدوء، ثم أكلها وقال: الموز لذيذ.', 'موزة صفراء', '🍌💛', 5, 'PUBLISHED', 'yellow_banana', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('الكتاب الكبير', 'فتحت سلمى كتابًا كبيرًا. رأت صورة قطة وصورة تفاحة. قرأت سلمى مع ماما بسعادة.', 'كتاب كبير', '📚⭐', 6, 'PUBLISHED', 'big_book', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("legacyKey") DO NOTHING;

-- تعديلات الأدمن السابقة على هذه القصص (العنوان والصورة والصوت)
UPDATE "Story" s SET
  "title" = COALESCE(NULLIF(o."title", ''), s."title"),
  "imageUrl" = COALESCE(o."imageUrl", s."imageUrl"),
  "audioUrl" = COALESCE(o."audioUrl", s."audioUrl")
FROM "EducationalContentOverride" o
WHERE o."unitId" = 'stories' AND o."targetKey" = 'story_' || s."legacyKey";
