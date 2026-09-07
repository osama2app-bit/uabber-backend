-- اشتراكات Apple In-App Purchase تُخزَّن في نفس جدول Subscription
-- حتى تبقى getAccessState ولوحة الأدمن والسجل تعمل بلا تعديل.

ALTER TABLE "Subscription"
ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN IF NOT EXISTS "appleOriginalTransactionId" TEXT,
ADD COLUMN IF NOT EXISTS "appleProductId" TEXT,
ADD COLUMN IF NOT EXISTS "appleLatestReceipt" TEXT,
ADD COLUMN IF NOT EXISTS "appleEnvironment" TEXT,
ADD COLUMN IF NOT EXISTS "appleLastCheckedAt" TIMESTAMP(3);

-- اشتراك آبل الواحد لا يُربط بأكثر من حساب.
CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_appleOriginalTransactionId_key"
ON "Subscription"("appleOriginalTransactionId");

CREATE INDEX IF NOT EXISTS "Subscription_provider_idx"
ON "Subscription"("provider");
