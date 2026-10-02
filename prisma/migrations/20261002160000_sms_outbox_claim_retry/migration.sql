-- Claim, retry, and provider-scoped message ids for the SMS outbox.
-- Existing rows stay valid. Null providerMessageId values do not collide.

ALTER TABLE "SmsOutbox" ADD COLUMN "provider" TEXT;
ALTER TABLE "SmsOutbox" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SmsOutbox" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
ALTER TABLE "SmsOutbox" ADD COLUMN "deliveryPollCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SmsOutbox" ADD COLUMN "nextDeliveryPollAt" TIMESTAMP(3);
ALTER TABLE "SmsOutbox" ADD COLUMN "lastError" TEXT;

UPDATE "SmsOutbox"
SET "provider" = 'mock'
WHERE "provider" IS NULL
  AND "providerMessageId" LIKE 'mock-%';

UPDATE "SmsOutbox"
SET "provider" = 'beem'
WHERE "provider" IS NULL
  AND "providerMessageId" ~ '^[0-9]+$';

UPDATE "SmsOutbox"
SET "provider" = 'swala'
WHERE "provider" IS NULL
  AND "providerMessageId" IS NOT NULL;

DROP INDEX "SmsOutbox_providerMessageId_idx";

CREATE UNIQUE INDEX "SmsOutbox_provider_providerMessageId_key"
ON "SmsOutbox"("provider", "providerMessageId");

CREATE INDEX "SmsOutbox_status_nextAttemptAt_idx"
ON "SmsOutbox"("status", "nextAttemptAt");
