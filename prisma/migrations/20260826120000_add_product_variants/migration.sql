-- Product variants: the sellable unit stops being the product and becomes the
-- size. See docs/specs/product-variants.md.

-- CreateTable
CREATE TABLE "product_variants" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "stock_quantity" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_product_id_label_key" ON "product_variants"("product_id", "label");

-- CreateIndex
CREATE INDEX "product_variants_product_id_position_idx" ON "product_variants"("product_id", "position");

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every product that exists becomes a product with exactly ONE
-- variant, labelled "Único", carrying the stock the product had.
--
-- This is the invariant the whole module rests on — "every product has at
-- least one variant, always" — established here rather than left to the
-- application. The alternative, products that predate variants having none,
-- is the second code path that makes this unmaintainable.
--
-- Arithmetic-neutral by construction: one row in, one row out, the same
-- number in it. SUM(product_variants.stock_quantity) equals the
-- SUM(products.stock_quantity) it was read from, and no unit is created or
-- lost.
INSERT INTO "product_variants" ("id", "product_id", "label", "position", "stock_quantity", "created_at", "updated_at")
SELECT gen_random_uuid()::text, "id", 'Único', 0, "stock_quantity", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "products";

-- AlterTable: cart lines address a variant.
--
-- product_id goes rather than staying alongside: the variant already names its
-- product, and two columns that must agree are two columns that can disagree.
ALTER TABLE "cart_items" ADD COLUMN "variant_id" TEXT;

UPDATE "cart_items" ci
SET "variant_id" = v."id"
FROM "product_variants" v
WHERE v."product_id" = ci."product_id";

ALTER TABLE "cart_items" ALTER COLUMN "variant_id" SET NOT NULL;

DROP INDEX "cart_items_cart_id_product_id_key";

ALTER TABLE "cart_items" DROP COLUMN "product_id";

CREATE UNIQUE INDEX "cart_items_cart_id_variant_id_key" ON "cart_items"("cart_id", "variant_id");

ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: order lines address a variant AND freeze its label.
--
-- product_id stays — it is the traceability that was always there, and it
-- still RESTRICTs deletion. variant_label joins product_name and
-- unit_price_cents as a snapshot: renaming a size later must not rewrite what
-- somebody bought. 'Único' is the honest label for everything sold before
-- sizes existed, because that is what was on sale.
ALTER TABLE "order_items" ADD COLUMN     "variant_id" TEXT,
ADD COLUMN     "variant_label" TEXT;

UPDATE "order_items" oi
SET "variant_id" = v."id", "variant_label" = v."label"
FROM "product_variants" v
WHERE v."product_id" = oi."product_id";

ALTER TABLE "order_items" ALTER COLUMN "variant_id" SET NOT NULL,
ALTER COLUMN "variant_label" SET NOT NULL;

-- Two sizes of the same shirt are two legitimate lines of one order, which the
-- old unique forbade.
DROP INDEX "order_items_order_id_product_id_key";

CREATE UNIQUE INDEX "order_items_order_id_variant_id_key" ON "order_items"("order_id", "variant_id");

ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: stock leaves the product for good.
--
-- Dropped rather than kept as a denormalized sum. A second place for stock to
-- live is a second place for it to be wrong, and the day the two disagree the
-- store sells what it does not have. ProductResponse.stockQuantity survives as
-- a number computed on read, which cannot drift from what checkout decrements.
-- The NOT NULL CHECK goes with the column and is reborn on the variant below.
ALTER TABLE "products" DROP COLUMN "stock_quantity";

-- Spec invariants (docs/specs/product-variants.md) restated where no future
-- code path can walk past them, same rationale as every other migration here:
-- the application validates all of this, but a CHECK is what survives a
-- refactor. Prisma does not model CHECK constraints, so they live only here.
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_stock_quantity_nonnegative" CHECK ("stock_quantity" >= 0);
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_position_nonnegative" CHECK ("position" >= 0);
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_label_not_blank" CHECK (length(btrim("label")) > 0);

-- Row Level Security, same posture as every other table (see the
-- 20260717002748_enable_row_level_security migration): Supabase exposes new
-- tables to the public anon key over PostgREST, RLS is not inherited, and a
-- table with RLS enabled and zero policies denies everything to non-owner
-- roles. Prisma connects as the owner and is unaffected.
ALTER TABLE "product_variants" ENABLE ROW LEVEL SECURITY;
