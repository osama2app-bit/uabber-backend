-- AlterTable
ALTER TABLE "EducationalQuestion" ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "ownerId" INTEGER,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'choice';

-- CreateIndex
CREATE INDEX "EducationalQuestion_ownerId_idx" ON "EducationalQuestion"("ownerId");
