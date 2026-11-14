-- AlterTable
ALTER TABLE "PaymentRequest" ADD COLUMN     "durationType" TEXT,
ADD COLUMN     "durationValue" INTEGER,
ADD COLUMN     "paymentMethod" TEXT NOT NULL DEFAULT 'cliq',
ADD COLUMN     "planId" INTEGER,
ADD COLUMN     "rejectionReason" TEXT;

-- CreateTable
CREATE TABLE "SubscriptionPlan" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'JOD',
    "durationType" TEXT NOT NULL DEFAULT 'months',
    "durationValue" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- الخطط الحالية كما كانت في التطبيق (يمكن للأدمن تعديلها لاحقًا)
INSERT INTO "SubscriptionPlan" ("name", "description", "price", "currency", "durationType", "durationValue", "isActive", "isFeatured", "sortOrder", "updatedAt") VALUES
  ('اشتراك شهر', 'استخدام كامل لمدة شهر', '1', 'JOD', 'months', 1, true, false, 0, CURRENT_TIMESTAMP),
  ('اشتراك 6 أشهر', 'الخيار الأفضل', '5', 'JOD', 'months', 6, true, true, 1, CURRENT_TIMESTAMP),
  ('اشتراك سنة', 'أفضل قيمة لمدة سنة كاملة', '10', 'JOD', 'months', 12, true, false, 2, CURRENT_TIMESTAMP);

-- بيانات CliQ الحالية
INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES
  ('cliq', '{"alias":"Aseele1999","accountName":"","bankName":"","instructions":"حوّل قيمة الباقة عبر CliQ إلى الاسم المستعار أدناه، ثم ارفع صورة إثبات التحويل."}', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
