-- Conductor cash-out via wakala till
ALTER TABLE "Withdrawal" ADD COLUMN IF NOT EXISTS "conductorUserId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Withdrawal_conductorUserId_fkey'
  ) THEN
    ALTER TABLE "Withdrawal"
      ADD CONSTRAINT "Withdrawal_conductorUserId_fkey"
      FOREIGN KEY ("conductorUserId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Withdrawal_conductorUserId_requestedAt_idx"
  ON "Withdrawal"("conductorUserId", "requestedAt");
