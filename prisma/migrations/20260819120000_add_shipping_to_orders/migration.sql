-- Shipping: freight becomes part of an order's money.
-- See docs/specs/shipping.md.

-- AlterTable
-- Unit weight for freight quoting. Nullable because every product that exists
-- today predates shipping, and refusing to sell until someone weighs them all
-- would take the storefront down; a missing weight falls back to
-- SHIPPING_DEFAULT_WEIGHT_GRAMS.
ALTER TABLE "products" ADD COLUMN     "weight_grams" INTEGER;

-- AlterTable
-- shipping_cents arrives WITH a default purely so the existing rows can satisfy
-- NOT NULL; the default is dropped a few statements below, once the backfill is
-- done. Leaving it in place would let a future code path omit freight entirely
-- and get a silent zero instead of an error.
ALTER TABLE "orders" ADD COLUMN     "shipping_cents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "items_subtotal_cents" INTEGER,
ADD COLUMN     "shipping_method_code" TEXT,
ADD COLUMN     "shipping_method_name" TEXT,
ADD COLUMN     "shipping_eta_days" INTEGER,
ADD COLUMN     "tracking_code" TEXT,
ADD COLUMN     "tracking_url" TEXT;

-- Backfill, deliberately arithmetic-neutral: before this module, total_cents WAS
-- the item subtotal, and every one of these orders was charged exactly that.
-- An order is an immutable financial record, so the migration is only allowed
-- to describe what already happened — never to restate it. After this, old
-- orders read as "no freight" (method null), which is the truth.
UPDATE "orders" SET "items_subtotal_cents" = "total_cents";

ALTER TABLE "orders" ALTER COLUMN "items_subtotal_cents" SET NOT NULL;

-- The scaffolding comes down.
ALTER TABLE "orders" ALTER COLUMN "shipping_cents" DROP DEFAULT;

-- The module's invariant, in a form no refactor can walk past. Prisma does not
-- model CHECK constraints, so — like the quantity and price checks in the
-- orders migration — they live only here.
--
-- Free shipping is a real price of zero, so shipping_cents is >= 0 while the
-- pre-existing total_cents > 0 check keeps standing: an order that costs
-- nothing at all is still not a thing.
ALTER TABLE "orders" ADD CONSTRAINT "orders_shipping_cents_not_negative" CHECK ("shipping_cents" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_items_subtotal_cents_positive" CHECK ("items_subtotal_cents" > 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_is_items_plus_shipping" CHECK ("total_cents" = "items_subtotal_cents" + "shipping_cents");

ALTER TABLE "products" ADD CONSTRAINT "products_weight_grams_positive" CHECK ("weight_grams" IS NULL OR "weight_grams" > 0);

-- No ENABLE ROW LEVEL SECURITY in this migration, and that is not an omission:
-- this module adds no table. Freight configuration lives in the environment and
-- the chosen method is a column on an order that is already locked down. The
-- project rule ("every new table is born with RLS deny-all in its own
-- migration") still stands — it simply has no subject here.
