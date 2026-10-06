-- AlterTable: Add physical dimensions and is_archived to product_variants
ALTER TABLE "product_variants" ADD COLUMN "height_cm" INTEGER,
ADD COLUMN "width_cm" INTEGER,
ADD COLUMN "length_cm" INTEGER,
ADD COLUMN "is_archived" BOOLEAN NOT NULL DEFAULT false;
