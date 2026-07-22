-- Payments: the Stripe-backed half of the money loop.
-- See docs/specs/payments.md.

-- AlterEnum
-- Refund is its own terminal state rather than a reuse of CANCELLED: money
-- that came back is a different event from an unpaid order that was abandoned.
-- Note this migration only ADDS the value and never compares against it —
-- Postgres refuses to use a new enum value in the transaction that created it.
ALTER TYPE "OrderStatus" ADD VALUE 'REFUNDED';

-- AlterTable
-- payment_ref already existed and keeps its meaning: the checkout SESSION
-- (cs_...). payment_intent_ref is the intent (pi_...), which only exists once
-- payment happens and is what refunds are issued against — one column could
-- not hold both without meaning "whichever id is most relevant right now".
ALTER TABLE "orders" ADD COLUMN     "payment_expires_at" TIMESTAMP(3),
ADD COLUMN     "payment_intent_ref" TEXT,
ADD COLUMN     "payment_url" TEXT,
ADD COLUMN     "refund_ref" TEXT,
ADD COLUMN     "refunded_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "order_id" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_events_order_id_idx" ON "payment_events"("order_id");

-- CreateIndex
-- charge.refunded carries the intent but no orderId of ours; this is how such
-- an event finds its order.
CREATE INDEX "orders_payment_intent_ref_idx" ON "orders"("payment_intent_ref");

-- No foreign key from payment_events to orders, deliberately: an event may
-- name an order that does not exist here (an object created in the Stripe
-- dashboard, a crossed test/live environment) and the audit row is worth
-- keeping regardless.

-- Row Level Security, same posture as every other table (see the
-- 20260717002748_enable_row_level_security migration): Supabase exposes new
-- tables to the public anon key over PostgREST, RLS is not inherited, and a
-- table with RLS enabled and zero policies denies everything to non-owner
-- roles. Prisma connects as the owner and is unaffected.
ALTER TABLE "payment_events" ENABLE ROW LEVEL SECURITY;
