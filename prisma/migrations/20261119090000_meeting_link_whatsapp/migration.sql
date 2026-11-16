-- AlterTable
ALTER TABLE "Consultation" ADD COLUMN     "meetingLinkAttemptAt" TIMESTAMP(3),
ADD COLUMN     "meetingLinkChannel" TEXT,
ADD COLUMN     "meetingLinkError" TEXT,
ADD COLUMN     "meetingLinkSentAt" TIMESTAMP(3),
ADD COLUMN     "meetingLinkSentUrl" TEXT,
ADD COLUMN     "meetingLinkStatus" TEXT;

