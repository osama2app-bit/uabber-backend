CREATE TABLE "AdminNotification" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sourceId" INTEGER NOT NULL,
    "route" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdminNotification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdminNotification_type_sourceId_key" ON "AdminNotification"("type", "sourceId");
CREATE INDEX "AdminNotification_isRead_createdAt_idx" ON "AdminNotification"("isRead", "createdAt");
