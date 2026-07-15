-- Payment decision timestamp used by approve/reject routes.
ALTER TABLE "PaymentRequest"
ADD COLUMN IF NOT EXISTS "decidedAt" TIMESTAMP(3);

-- Subscription plan/audit fields.
ALTER TABLE "Subscription"
ADD COLUMN IF NOT EXISTS "paymentRequestId" INTEGER,
ADD COLUMN IF NOT EXISTS "planName" TEXT,
ADD COLUMN IF NOT EXISTS "planMonths" INTEGER,
ADD COLUMN IF NOT EXISTS "amount" TEXT;

-- A payment request must never grant subscription time more than once.
CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_paymentRequestId_key"
ON "Subscription"("paymentRequestId");

CREATE INDEX IF NOT EXISTS "PaymentRequest_userId_status_idx"
ON "PaymentRequest"("userId", "status");

CREATE INDEX IF NOT EXISTS "Subscription_userId_status_expiryDate_idx"
ON "Subscription"("userId", "status", "expiryDate");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Subscription_paymentRequestId_fkey'
  ) THEN
    ALTER TABLE "Subscription"
    ADD CONSTRAINT "Subscription_paymentRequestId_fkey"
    FOREIGN KEY ("paymentRequestId")
    REFERENCES "PaymentRequest"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;
  END IF;
END $$;
