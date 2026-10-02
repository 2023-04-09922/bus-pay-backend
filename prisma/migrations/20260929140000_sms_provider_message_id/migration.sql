-- Store the provider message id so delivery webhooks can update the same row.
-- Nullable columns only. Existing PENDING/SENT/SENT_MOCK/FAILED rows stay valid.

ALTER TABLE "SmsOutbox" ADD COLUMN "providerMessageId" TEXT;
ALTER TABLE "SmsOutbox" ADD COLUMN "providerStatus" TEXT;
ALTER TABLE "SmsOutbox" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "SmsOutbox_providerMessageId_idx" ON "SmsOutbox"("providerMessageId");
