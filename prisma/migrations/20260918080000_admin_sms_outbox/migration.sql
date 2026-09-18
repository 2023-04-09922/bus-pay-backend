ALTER TYPE "UserRole" ADD VALUE 'ADMIN';

CREATE TABLE "SmsOutbox" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsOutbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SmsOutbox_status_createdAt_idx" ON "SmsOutbox"("status", "createdAt");
