-- Add the new consultation statuses safely.
ALTER TYPE "ConsultationStatus" ADD VALUE IF NOT EXISTS 'PAYMENT_CONFIRMED';
ALTER TYPE "ConsultationStatus" ADD VALUE IF NOT EXISTS 'COMPLETED';
ALTER TYPE "ConsultationStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- Convert the SpecialistAvailability table created by the previous migration
-- from: specialistName + availableDate + startTime
-- to:   specialist + startAt + durationMinutes
ALTER TABLE "SpecialistAvailability"
  ADD COLUMN IF NOT EXISTS "specialist" TEXT,
  ADD COLUMN IF NOT EXISTS "startAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "durationMinutes" INTEGER;

-- Preserve all existing appointment data.
UPDATE "SpecialistAvailability"
SET "specialist" = COALESCE("specialist", "specialistName")
WHERE "specialist" IS NULL;

UPDATE "SpecialistAvailability"
SET "startAt" = COALESCE(
  "startAt",
  date_trunc('day', "availableDate") + ("startTime"::time)
)
WHERE "startAt" IS NULL;

UPDATE "SpecialistAvailability"
SET "durationMinutes" = COALESCE("durationMinutes", 30)
WHERE "durationMinutes" IS NULL;

ALTER TABLE "SpecialistAvailability"
  ALTER COLUMN "specialist" SET NOT NULL,
  ALTER COLUMN "startAt" SET NOT NULL,
  ALTER COLUMN "durationMinutes" SET NOT NULL;

-- Remove indexes belonging to the old table shape.
DROP INDEX IF EXISTS "SpecialistAvailability_specialistName_availableDate_startTime_key";
DROP INDEX IF EXISTS "SpecialistAvailability_specialistName_availableDate_isAvailable_idx";

-- Remove the old columns after their data has been copied.
ALTER TABLE "SpecialistAvailability"
  DROP COLUMN IF EXISTS "specialistName",
  DROP COLUMN IF EXISTS "availableDate",
  DROP COLUMN IF EXISTS "startTime";

-- Create indexes required by the current Prisma schema.
CREATE UNIQUE INDEX IF NOT EXISTS "SpecialistAvailability_specialist_startAt_durationMinutes_key"
ON "SpecialistAvailability"("specialist", "startAt", "durationMinutes");

CREATE INDEX IF NOT EXISTS "SpecialistAvailability_isAvailable_startAt_idx"
ON "SpecialistAvailability"("isAvailable", "startAt");

-- Add the new Consultation fields.
ALTER TABLE "Consultation" ADD COLUMN IF NOT EXISTS "availabilityId" INTEGER;
ALTER TABLE "Consultation" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "Consultation" ADD COLUMN IF NOT EXISTS "receiptUrl" TEXT;
ALTER TABLE "Consultation" ADD COLUMN IF NOT EXISTS "durationMinutes" INTEGER;
ALTER TABLE "Consultation" ADD COLUMN IF NOT EXISTS "priceJod" INTEGER;
ALTER TABLE "Consultation" ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT;

-- Backfill safe defaults for existing consultations.
UPDATE "Consultation" SET
  "phone" = COALESCE("phone", ''),
  "receiptUrl" = COALESCE("receiptUrl", ''),
  "durationMinutes" = COALESCE("durationMinutes", 30),
  "priceJod" = COALESCE("priceJod", 5),
  "date" = COALESCE("date", "createdAt"),
  "time" = COALESCE("time", to_char(COALESCE("date", "createdAt"), 'HH24:MI'));

CREATE INDEX IF NOT EXISTS "Consultation_status_createdAt_idx"
ON "Consultation"("status", "createdAt");

CREATE INDEX IF NOT EXISTS "Consultation_availabilityId_idx"
ON "Consultation"("availabilityId");

-- Add the relation only when it does not already exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Consultation_availabilityId_fkey'
  ) THEN
    ALTER TABLE "Consultation"
      ADD CONSTRAINT "Consultation_availabilityId_fkey"
      FOREIGN KEY ("availabilityId")
      REFERENCES "SpecialistAvailability"("id")
      ON DELETE RESTRICT
      ON UPDATE CASCADE;
  END IF;
END $$;
