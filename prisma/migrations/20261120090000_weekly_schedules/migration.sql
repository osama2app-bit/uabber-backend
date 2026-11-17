-- CreateEnum
CREATE TYPE "SlotStatus" AS ENUM ('AVAILABLE', 'BOOKED', 'COMPLETED', 'CANCELLED', 'UNAVAILABLE');

-- AlterTable
ALTER TABLE "SpecialistAvailability" ADD COLUMN     "scheduleId" INTEGER,
ADD COLUMN     "status" "SlotStatus" NOT NULL DEFAULT 'AVAILABLE';

-- CreateTable
CREATE TABLE "SpecialistSchedule" (
    "id" SERIAL NOT NULL,
    "specialistProfileId" INTEGER NOT NULL,
    "weekdays" INTEGER[],
    "startMinutes" INTEGER NOT NULL,
    "endMinutes" INTEGER NOT NULL,
    "sessionMinutes" INTEGER NOT NULL,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "maxSessionsPerDay" INTEGER NOT NULL,
    "timeZone" TEXT NOT NULL DEFAULT 'Asia/Amman',
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastGeneratedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpecialistSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SpecialistSchedule_specialistProfileId_key" ON "SpecialistSchedule"("specialistProfileId");

-- AddForeignKey
ALTER TABLE "SpecialistAvailability" ADD CONSTRAINT "SpecialistAvailability_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "SpecialistSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpecialistSchedule" ADD CONSTRAINT "SpecialistSchedule_specialistProfileId_fkey" FOREIGN KEY ("specialistProfileId") REFERENCES "SpecialistProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- حالة المواعيد الموجودة (بدون حذف أو تعديل أي حجز)
UPDATE "SpecialistAvailability" a SET "status" = 'COMPLETED'
WHERE EXISTS (SELECT 1 FROM "Consultation" c WHERE c."availabilityId" = a."id" AND c."status" = 'COMPLETED');

UPDATE "SpecialistAvailability" a SET "status" = 'BOOKED'
WHERE a."status" = 'AVAILABLE'
  AND EXISTS (SELECT 1 FROM "Consultation" c WHERE c."availabilityId" = a."id"
              AND c."status" IN ('NEW', 'PAYMENT_CONFIRMED', 'ACCEPTED', 'CHANGED'));

UPDATE "SpecialistAvailability" SET "status" = 'UNAVAILABLE'
WHERE "status" = 'AVAILABLE' AND "isAvailable" = false;
