-- AlterTable
ALTER TABLE "Terminal" ADD COLUMN     "ownerUserId" TEXT;

-- CreateIndex
CREATE INDEX "Terminal_ownerUserId_idx" ON "Terminal"("ownerUserId");

-- AddForeignKey
ALTER TABLE "Terminal" ADD CONSTRAINT "Terminal_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
