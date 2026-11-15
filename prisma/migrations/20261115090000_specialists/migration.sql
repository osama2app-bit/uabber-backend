-- CreateEnum
CREATE TYPE "SpecialistStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- DropIndex
DROP INDEX "SpecialistAvailability_specialist_startAt_durationMinutes_key";

-- AlterTable
ALTER TABLE "Consultation" ADD COLUMN     "meetingEventId" TEXT,
ADD COLUMN     "meetingUrl" TEXT,
ADD COLUMN     "specialistProfileId" INTEGER;

-- AlterTable
ALTER TABLE "SpecialistAvailability" ADD COLUMN     "specialistProfileId" INTEGER;

-- AlterTable
ALTER TABLE "SubscriptionPlan" ADD COLUMN     "appleProductId" TEXT,
ADD COLUMN     "audience" TEXT NOT NULL DEFAULT 'family';

-- CreateTable
CREATE TABLE "SpecialistProfile" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "displayName" TEXT NOT NULL,
    "specialty" TEXT NOT NULL,
    "title" TEXT,
    "bio" TEXT,
    "photoUrl" TEXT,
    "licenseUrl" TEXT,
    "phone" TEXT,
    "sessionPriceJod" INTEGER NOT NULL DEFAULT 10,
    "sessionMinutes" INTEGER NOT NULL DEFAULT 45,
    "status" "SpecialistStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "subscriptionExpiry" TIMESTAMP(3),
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpecialistProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SpecialistProfile_userId_key" ON "SpecialistProfile"("userId");

-- CreateIndex
CREATE INDEX "SpecialistProfile_status_specialty_idx" ON "SpecialistProfile"("status", "specialty");

-- CreateIndex
CREATE INDEX "Consultation_specialistProfileId_idx" ON "Consultation"("specialistProfileId");

-- CreateIndex
CREATE INDEX "SpecialistAvailability_specialist_startAt_idx" ON "SpecialistAvailability"("specialist", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "SpecialistAvailability_specialistProfileId_startAt_key" ON "SpecialistAvailability"("specialistProfileId", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlan_appleProductId_key" ON "SubscriptionPlan"("appleProductId");

-- AddForeignKey
ALTER TABLE "SpecialistAvailability" ADD CONSTRAINT "SpecialistAvailability_specialistProfileId_fkey" FOREIGN KEY ("specialistProfileId") REFERENCES "SpecialistProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consultation" ADD CONSTRAINT "Consultation_specialistProfileId_fkey" FOREIGN KEY ("specialistProfileId") REFERENCES "SpecialistProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpecialistProfile" ADD CONSTRAINT "SpecialistProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ربط منتجات App Store الحالية بالخطط الحالية
UPDATE "SubscriptionPlan" SET "appleProductId" = 'com.uabber.learn.monthly' WHERE "name" = 'اشتراك شهر' AND "appleProductId" IS NULL;
UPDATE "SubscriptionPlan" SET "appleProductId" = 'com.uabber.learn.sixmonths' WHERE "name" = 'اشتراك 6 أشهر' AND "appleProductId" IS NULL;
UPDATE "SubscriptionPlan" SET "appleProductId" = 'com.uabber.learn.yearly' WHERE "name" = 'اشتراك سنة' AND "appleProductId" IS NULL;

-- خطط اشتراك الأخصائيين (يعدّلها الأدمن من لوحة التحكم)
INSERT INTO "SubscriptionPlan" ("name", "description", "price", "currency", "durationType", "durationValue", "isActive", "isFeatured", "sortOrder", "audience", "updatedAt") VALUES
  ('اشتراك أخصائي - شهر', 'ظهور ملفك واستقبال الحجوزات لمدة شهر', '10', 'JOD', 'months', 1, true, false, 100, 'specialist', CURRENT_TIMESTAMP),
  ('اشتراك أخصائي - 6 أشهر', 'ظهور ملفك واستقبال الحجوزات لمدة 6 أشهر', '50', 'JOD', 'months', 6, true, true, 101, 'specialist', CURRENT_TIMESTAMP);
