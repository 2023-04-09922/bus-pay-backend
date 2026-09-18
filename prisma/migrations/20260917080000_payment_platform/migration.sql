-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');
CREATE TYPE "CardStatus" AS ENUM ('ACTIVE', 'FROZEN', 'REPLACED', 'LOST', 'DAMAGED');
CREATE TYPE "MerchantCategory" AS ENUM ('TRANSPORT', 'RETAIL', 'FERRY', 'STADIUM', 'EVENT', 'PARKING', 'OTHER');
CREATE TYPE "MerchantStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "TerminalType" AS ENUM ('NFC_READER', 'POS', 'GATE', 'APP');
CREATE TYPE "TerminalStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "ServiceType" AS ENUM ('TRANSPORT', 'RETAIL', 'FERRY', 'STADIUM', 'EVENT', 'PARKING', 'OTHER');
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'REVERSED');

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "nida" TEXT NOT NULL,
    "email" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "publicCode" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Card" (
    "id" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "nfcUid" TEXT,
    "status" "CardStatus" NOT NULL DEFAULT 'ACTIVE',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "walletId" TEXT NOT NULL,
    "replacedById" TEXT,

    CONSTRAINT "Card_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "merchantCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "MerchantCategory" NOT NULL,
    "settlementAccount" TEXT,
    "ownerUserId" TEXT,
    "status" "MerchantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Terminal" (
    "id" TEXT NOT NULL,
    "terminalCode" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "type" "TerminalType" NOT NULL,
    "status" "TerminalStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "Terminal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentTransaction" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "terminalId" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "serviceType" "ServiceType" NOT NULL,
    "status" "TransactionStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Customer_phone_key" ON "Customer"("phone");
CREATE UNIQUE INDEX "Customer_nida_key" ON "Customer"("nida");
CREATE UNIQUE INDEX "Wallet_publicCode_key" ON "Wallet"("publicCode");
CREATE UNIQUE INDEX "Wallet_customerId_key" ON "Wallet"("customerId");
CREATE UNIQUE INDEX "Card_serialNumber_key" ON "Card"("serialNumber");
CREATE UNIQUE INDEX "Card_nfcUid_key" ON "Card"("nfcUid");
CREATE UNIQUE INDEX "Card_replacedById_key" ON "Card"("replacedById");
CREATE UNIQUE INDEX "Merchant_merchantCode_key" ON "Merchant"("merchantCode");
CREATE UNIQUE INDEX "Terminal_terminalCode_key" ON "Terminal"("terminalCode");
CREATE UNIQUE INDEX "PaymentTransaction_reference_key" ON "PaymentTransaction"("reference");
CREATE INDEX "PaymentTransaction_createdAt_idx" ON "PaymentTransaction"("createdAt");
CREATE INDEX "PaymentTransaction_walletId_createdAt_idx" ON "PaymentTransaction"("walletId", "createdAt");

ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Card" ADD CONSTRAINT "Card_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Card" ADD CONSTRAINT "Card_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "Card"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Merchant" ADD CONSTRAINT "Merchant_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Terminal" ADD CONSTRAINT "Terminal_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "Merchant" ("id", "merchantCode", "name", "category", "status", "createdAt", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'DLD-PLATFORM',
  'BusPay Daladala',
  'TRANSPORT',
  'ACTIVE',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
