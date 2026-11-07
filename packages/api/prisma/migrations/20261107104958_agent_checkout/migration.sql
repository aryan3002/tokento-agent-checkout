-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "paypalPayoutEmail" TEXT;

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "imageUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSandbox" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkout_orders" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "rewardTokenId" TEXT,
    "rewardAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "amountToPay" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "earnRuleId" TEXT,
    "expectedEarn" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "earnedTokenId" TEXT,
    "redemptionId" TEXT,
    "redemptionSettlementRef" TEXT,
    "reissuedTokenId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "paymentMode" TEXT NOT NULL DEFAULT 'approval',
    "outsideMandate" BOOLEAN NOT NULL DEFAULT false,
    "mandateId" TEXT,
    "agentId" TEXT,
    "agentReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "paypalOrderId" TEXT,
    "paypalCaptureId" TEXT,
    "paypalRefundId" TEXT,
    "approvalUrl" TEXT,
    "platformFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "settlementId" TEXT,
    "refundNettedSettlementId" TEXT,
    "note" TEXT,
    "isSandbox" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),

    CONSTRAINT "checkout_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paypal_webhook_events" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "resourceId" TEXT,
    "verified" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "paypal_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mandates" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "perPurchaseMax" DECIMAL(12,2) NOT NULL,
    "monthlyCap" DECIMAL(12,2) NOT NULL,
    "allowedMerchantIds" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "vaultStatus" TEXT NOT NULL DEFAULT 'NONE',
    "paypalSetupTokenId" TEXT,
    "paypalPaymentTokenId" TEXT,
    "paypalCustomerId" TEXT,
    "isSandbox" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "mandates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_batches" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "gross" DECIMAL(12,2) NOT NULL,
    "fees" DECIMAL(12,2) NOT NULL,
    "refundAdjustments" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "net" DECIMAL(12,2) NOT NULL,
    "receiverEmail" TEXT NOT NULL,
    "paypalPayoutBatchId" TEXT,
    "error" TEXT,
    "isSandbox" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "settlement_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "products_category_idx" ON "products"("category");

-- CreateIndex
CREATE UNIQUE INDEX "products_merchantId_sku_key" ON "products"("merchantId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_orders_rewardTokenId_key" ON "checkout_orders"("rewardTokenId");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_orders_earnedTokenId_key" ON "checkout_orders"("earnedTokenId");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_orders_redemptionId_key" ON "checkout_orders"("redemptionId");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_orders_reissuedTokenId_key" ON "checkout_orders"("reissuedTokenId");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_orders_paypalOrderId_key" ON "checkout_orders"("paypalOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_orders_paypalCaptureId_key" ON "checkout_orders"("paypalCaptureId");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_orders_paypalRefundId_key" ON "checkout_orders"("paypalRefundId");

-- CreateIndex
CREATE INDEX "checkout_orders_merchantId_status_idx" ON "checkout_orders"("merchantId", "status");

-- CreateIndex
CREATE INDEX "checkout_orders_customerId_createdAt_idx" ON "checkout_orders"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "checkout_orders_status_createdAt_idx" ON "checkout_orders"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_orders_customerId_idempotencyKey_key" ON "checkout_orders"("customerId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "paypal_webhook_events_eventType_idx" ON "paypal_webhook_events"("eventType");

-- CreateIndex
CREATE INDEX "paypal_webhook_events_receivedAt_idx" ON "paypal_webhook_events"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "mandates_paypalSetupTokenId_key" ON "mandates"("paypalSetupTokenId");

-- CreateIndex
CREATE INDEX "mandates_customerId_status_idx" ON "mandates"("customerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_batches_paypalPayoutBatchId_key" ON "settlement_batches"("paypalPayoutBatchId");

-- CreateIndex
CREATE INDEX "settlement_batches_merchantId_createdAt_idx" ON "settlement_batches"("merchantId", "createdAt");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_orders" ADD CONSTRAINT "checkout_orders_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_orders" ADD CONSTRAINT "checkout_orders_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_orders" ADD CONSTRAINT "checkout_orders_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "settlement_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_orders" ADD CONSTRAINT "checkout_orders_refundNettedSettlementId_fkey" FOREIGN KEY ("refundNettedSettlementId") REFERENCES "settlement_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_batches" ADD CONSTRAINT "settlement_batches_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
