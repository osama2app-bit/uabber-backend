-- CreateTable
CREATE TABLE "PendingMeetingDeletion" (
    "id" SERIAL NOT NULL,
    "eventId" TEXT NOT NULL,
    "consultationId" INTEGER,
    "reason" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingMeetingDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingMeetingDeletion_eventId_key" ON "PendingMeetingDeletion"("eventId");

-- CreateIndex
CREATE INDEX "PendingMeetingDeletion_createdAt_idx" ON "PendingMeetingDeletion"("createdAt");

