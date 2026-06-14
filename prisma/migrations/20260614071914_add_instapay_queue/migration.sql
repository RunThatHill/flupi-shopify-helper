-- CreateTable
CREATE TABLE "InstapayOrderQueue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyOrderId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "totalPrice" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "screenshotPath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "InstapayOrderQueue_shopifyOrderId_key" ON "InstapayOrderQueue"("shopifyOrderId");
