/**
 * Charging money, behind a token — the same seam as MailService: orders
 * depends on this interface, never on a concrete gateway, so swapping the
 * FakePaymentProvider for Stripe is a payments-module change and nothing
 * else (docs/architecture/modules.md, docs/specs/orders.md).
 *
 * v1 is deliberately this thin: checkout registers the payment intent and
 * stores the returned reference. Confirmation does NOT flow through here —
 * the CREATED → PAID transition is OrdersService.markPaid, which today an
 * operator triggers over HTTP and tomorrow the Stripe webhook calls. Webhook
 * verification, retries and refunds are the payments spec's problem, later.
 */
export interface PaymentProvider {
  createPayment(input: {
    orderId: string;
    amountCents: number;
  }): Promise<{ providerRef: string }>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
