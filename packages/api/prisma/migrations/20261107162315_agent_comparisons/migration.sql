-- CreateTable
CREATE TABLE "agent_comparisons" (
    "id" TEXT NOT NULL,
    "comparisonId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "effectiveCost" DECIMAL(12,2) NOT NULL,
    "storesCompared" INTEGER NOT NULL,
    "isSandbox" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_comparisons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_comparisons_merchantId_isSandbox_createdAt_idx" ON "agent_comparisons"("merchantId", "isSandbox", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_comparisons_comparisonId_merchantId_key" ON "agent_comparisons"("comparisonId", "merchantId");

-- AddForeignKey
ALTER TABLE "agent_comparisons" ADD CONSTRAINT "agent_comparisons_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_comparisons" ADD CONSTRAINT "agent_comparisons_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

