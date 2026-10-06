-- AlterTable: Add structured address fields to orders
ALTER TABLE "orders" ADD COLUMN "shipping_street" TEXT,
ADD COLUMN "shipping_number" TEXT,
ADD COLUMN "shipping_complement" TEXT,
ADD COLUMN "shipping_neighborhood" TEXT;
