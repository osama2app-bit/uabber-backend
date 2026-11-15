-- CreateTable
CREATE TABLE "AppleSpecialistPurchase" (
    "id" SERIAL NOT NULL,
    "transactionId" TEXT NOT NULL,
    "originalTransactionId" TEXT,
    "userId" INTEGER NOT NULL,
    "specialistProfileId" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "environment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppleSpecialistPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppleSpecialistPurchase_transactionId_key" ON "AppleSpecialistPurchase"("transactionId");

-- CreateIndex
CREATE INDEX "AppleSpecialistPurchase_userId_idx" ON "AppleSpecialistPurchase"("userId");


-- معرّفات منتجات آبل لباقات الأخصائيين (Non-Renewing Subscription في App Store Connect)
UPDATE "SubscriptionPlan" SET "appleProductId" = 'com.uabber.learn.specialist.45days'
WHERE "audience" = 'specialist' AND "appleProductId" IS NULL AND "durationType" = 'days' AND "durationValue" = 45
  AND NOT EXISTS (SELECT 1 FROM "SubscriptionPlan" WHERE "appleProductId" = 'com.uabber.learn.specialist.45days');

UPDATE "SubscriptionPlan" SET "appleProductId" = 'com.uabber.learn.specialist.3months'
WHERE "audience" = 'specialist' AND "appleProductId" IS NULL AND "durationType" = 'months' AND "durationValue" = 3
  AND NOT EXISTS (SELECT 1 FROM "SubscriptionPlan" WHERE "appleProductId" = 'com.uabber.learn.specialist.3months');
