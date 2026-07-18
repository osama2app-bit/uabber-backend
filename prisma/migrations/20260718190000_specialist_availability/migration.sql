CREATE TABLE "SpecialistAvailability" (
  "id" SERIAL NOT NULL,
  "specialistName" TEXT NOT NULL,
  "availableDate" TIMESTAMP(3) NOT NULL,
  "startTime" TEXT NOT NULL,
  "isAvailable" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SpecialistAvailability_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SpecialistAvailability_specialistName_availableDate_startTime_key"
ON "SpecialistAvailability"("specialistName", "availableDate", "startTime");

CREATE INDEX "SpecialistAvailability_specialistName_availableDate_isAvailable_idx"
ON "SpecialistAvailability"("specialistName", "availableDate", "isAvailable");
