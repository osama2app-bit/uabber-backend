CREATE TABLE "EducationalContentOverride" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "speechText" TEXT NOT NULL,
    "imageUrl" TEXT,
    "audioUrl" TEXT,
    "isOverride" BOOLEAN NOT NULL DEFAULT false,
    "targetKey" TEXT,
    "updatedById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EducationalContentOverride_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "UserContentCustomization" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "contentKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "speechText" TEXT NOT NULL,
    "imageUrl" TEXT,
    "audioUrl" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserContentCustomization_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EducationalContentOverride_unitId_idx" ON "EducationalContentOverride"("unitId");
CREATE INDEX "EducationalContentOverride_targetKey_idx" ON "EducationalContentOverride"("targetKey");
CREATE INDEX "UserContentCustomization_userId_idx" ON "UserContentCustomization"("userId");
CREATE UNIQUE INDEX "UserContentCustomization_userId_contentKey_key" ON "UserContentCustomization"("userId", "contentKey");
ALTER TABLE "EducationalContentOverride" ADD CONSTRAINT "EducationalContentOverride_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserContentCustomization" ADD CONSTRAINT "UserContentCustomization_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
