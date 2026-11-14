-- CreateTable
CREATE TABLE "EventSequenceGroup" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "coverImageUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "ownerId" INTEGER,
    "clientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventSequenceGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventSequenceEvent" (
    "id" SERIAL NOT NULL,
    "groupId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "audioUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventSequenceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventSequenceGroup_ownerId_isActive_sortOrder_idx" ON "EventSequenceGroup"("ownerId", "isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "EventSequenceGroup_ownerId_clientId_key" ON "EventSequenceGroup"("ownerId", "clientId");

-- CreateIndex
CREATE INDEX "EventSequenceEvent_groupId_sortOrder_idx" ON "EventSequenceEvent"("groupId", "sortOrder");

-- AddForeignKey
ALTER TABLE "EventSequenceGroup" ADD CONSTRAINT "EventSequenceGroup_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSequenceEvent" ADD CONSTRAINT "EventSequenceEvent_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "EventSequenceGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
