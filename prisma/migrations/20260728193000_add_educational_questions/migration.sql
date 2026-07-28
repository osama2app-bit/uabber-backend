CREATE TABLE "EducationalQuestion" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "sourceKey" TEXT,
    "question" TEXT NOT NULL,
    "speechText" TEXT NOT NULL,
    "correctTitle" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isOverride" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EducationalQuestion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EducationalQuestion_unitId_itemKey_idx" ON "EducationalQuestion"("unitId", "itemKey");
CREATE INDEX "EducationalQuestion_sourceKey_idx" ON "EducationalQuestion"("sourceKey");

ALTER TABLE "EducationalQuestion"
ADD CONSTRAINT "EducationalQuestion_updatedById_fkey"
FOREIGN KEY ("updatedById") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
