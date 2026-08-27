import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';

import { PasswordService } from '../src/auth/password.service';
import { OrderStatus, ProductStatus } from '../src/generated/prisma/enums';
import { RATE_LIMITS } from '../src/orders/rate-limits';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './support/app';
import { createUserWithRole, resetCatalogTables } from './support/catalog-db';
import { resetAuthTables } from './support/db';
import type { OfflineStripe } from './support/offline-stripe';
import { resetOrdersTables } from './support/orders-db';

const PASSWORD = 'correct horse battery staple';

const ADDRESS = {
  line1: 'Rua das Flores, 123',
  city: 'Curitiba',
  state: 'PR',
  postalCode: '80000-000',
};

interface PaymentView {
  mode: 'hosted' | 'embedded';
  url: string | null;
  clientSecret: string | null;
  expiresAt: string;
}

interface OrderResponse {
  id: string;
  status: OrderStatus;
  itemsSubtotalCents: number;
  shippingCents: number;
  totalCents: number;
  paymentRef: string | null;
  paymentUrl: string | null;
  paymentIntentRef: string | null;
  refundRef: string | null;
  refundedAt: string | null;
  paidAt: string | null;
  payment: PaymentView | null;
}

/**
 * Covers docs/specs/payments.md at the HTTP level, against the real database.
 *
 * The point of interest is the webhook: signature verification is the real SDK
 * code running against payloads this suite signs itself with the SDK's own
 * test-header helper, over the real raw body, through the real global guards.
 * Only Stripe's two network calls are answered from memory (see
 * support/offline-stripe.ts) — the money-moving HTTP calls remain the one
 * thing no automated test here exercises, the same honest gap the mail
 * provider has.
 */
describe('Payments (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let stripe: OfflineStripe;
  let webhookSecret: string;
  let resetRateLimits: () => void;

  let adminToken: string;
  let operatorToken: string;
  let customerToken: string;
  let customerBToken: string;

  let eventSequence = 0;

  beforeAll(async () => {
    ({ app, prisma, stripe, webhookSecret, resetRateLimits } =
      await createTestApp());
    const passwords = app.get(PasswordService);
    const passwordHash = await passwords.hash(PASSWORD);

    await resetOrdersTables(prisma);
    await resetAuthTables(prisma);
    await resetCatalogTables(prisma);

    for (const roleName of ['admin', 'operator', 'customer']) {
      await createUserWithRole(prisma, {
        email: `payments-${roleName}@example.com`,
        passwordHash,
        roleName,
      });
    }
    await createUserWithRole(prisma, {
      email: 'payments-customer-b@example.com',
      passwordHash,
      roleName: 'customer',
    });

    adminToken = await login('payments-admin@example.com');
    operatorToken = await login('payments-operator@example.com');
    customerToken = await login('payments-customer@example.com');
    customerBToken = await login('payments-customer-b@example.com');
  });

  beforeEach(async () => {
    await resetOrdersTables(prisma);
    await resetCatalogTables(prisma);
    stripe.reset();
    resetRateLimits();
  });

  afterAll(async () => {
    await resetOrdersTables(prisma);
    await resetCatalogTables(prisma);
    await resetAuthTables(prisma);
    await app.close();
  });

  function http() {
    return request(app.getHttpServer());
  }

  async function login(email: string): Promise<string> {
    const response = await http()
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  }

  interface ProductResponse {
    id: string;
    variants: { id: string; label: string; stockQuantity: number }[];
  }

  /** A product with one size; stock lives on the variant now. */
  async function createProduct(
    overrides: Record<string, unknown> = {},
  ): Promise<ProductResponse> {
    const response = await http()
      .post('/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Camiseta Azul',
        priceCents: 4990,
        status: ProductStatus.ACTIVE,
        variants: [{ label: 'Único', stockQuantity: 10 }],
        ...overrides,
      })
      .expect(201);

    return response.body as ProductResponse;
  }

  /** A cart with one size of one product, ready to check out. */
  async function fillCart(
    token = customerToken,
    quantity = 2,
  ): Promise<ProductResponse> {
    const product = await createProduct();
    await http()
      .post('/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ variantId: product.variants[0].id, quantity })
      .expect(201);

    return product;
  }

  /**
   * Freight for the caller's current cart. Checkout re-quotes and compares, so
   * a payments test has to go through the same door a storefront does.
   */
  async function quotedShipping(
    token: string,
  ): Promise<{ shippingOptionCode: string; quotedShippingCents: number }> {
    const response = await http()
      .post('/shipping/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({ postalCode: ADDRESS.postalCode })
      .expect(200);

    const { options } = response.body as {
      options: { code: string; priceCents: number }[];
    };

    return {
      shippingOptionCode: options[0].code,
      quotedShippingCents: options[0].priceCents,
    };
  }

  async function checkout(
    token = customerToken,
    body: Record<string, unknown> = {},
  ): Promise<OrderResponse> {
    const response = await http()
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        shippingAddress: ADDRESS,
        ...(await quotedShipping(token)),
        ...body,
      })
      .expect(201);

    return response.body as OrderResponse;
  }

  async function orderOf(id: string): Promise<OrderResponse> {
    const response = await http()
      .get(`/orders/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    return response.body as OrderResponse;
  }

  /** Stock of one size, read straight from the table that now holds it. */
  async function stockOf(variantId: string): Promise<number> {
    const variant = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variantId },
      select: { stockQuantity: true },
    });

    return variant.stockQuantity;
  }

  function nextEventId(): string {
    eventSequence += 1;

    return `evt_test_${String(eventSequence)}`;
  }

  /** A provider event, signed exactly the way a real delivery would be. */
  function deliver(event: Record<string, unknown>, secret = webhookSecret) {
    const payload = JSON.stringify(event);

    return http()
      .post('/payments/webhook')
      .set('stripe-signature', stripe.sign(payload, secret))
      .set('content-type', 'application/json')
      .send(payload);
  }

  function sessionEvent(
    type: string,
    sessionId: string,
    id = nextEventId(),
  ): Record<string, unknown> {
    const session = stripe.session(sessionId);

    return {
      id,
      object: 'event',
      type,
      data: {
        object: {
          id: session.id,
          object: 'checkout.session',
          client_reference_id: session.client_reference_id,
          payment_status: session.payment_status,
          payment_intent: session.payment_intent,
        },
      },
    };
  }

  /**
   * A real charge.refunded event, captured from Stripe and frozen, with the
   * payment intent re-pointed at a given order. Faithful to what the gateway
   * actually sends today (no expanded refunds list, no charge metadata), which
   * is exactly why the order is found by intent and refundRef comes back null.
   */
  function realChargeRefunded(intentRef: string): Record<string, unknown> {
    const event = JSON.parse(
      readFileSync(join(__dirname, 'fixtures/charge-refunded.json'), 'utf8'),
    ) as {
      id: string;
      data: { object: { payment_intent: string } };
    };
    event.id = nextEventId();
    event.data.object.payment_intent = intentRef;

    return event;
  }

  /** Pays an order the way a buyer would: on the provider, then a webhook. */
  async function payOrder(order: OrderResponse): Promise<OrderResponse> {
    const sessionId = order.paymentRef;
    if (!sessionId) {
      throw new Error('Order has no payment session to pay');
    }

    stripe.markSessionPaid(sessionId);
    await deliver(sessionEvent('checkout.session.completed', sessionId)).expect(
      200,
    );

    return orderOf(order.id);
  }

  describe('checkout and payment sessions', () => {
    it('opens a hosted session and returns the way to pay it', async () => {
      await fillCart();

      const order = await checkout();

      expect(order.status).toBe(OrderStatus.CREATED);
      expect(order.paymentRef).toMatch(/^cs_test_/);
      expect(order.payment).toEqual({
        mode: 'hosted',
        url: expect.stringContaining('checkout.stripe.test') as string,
        clientSecret: null,
        expiresAt: expect.any(String) as string,
      });
      // Persisted for hosted, so a later GET can still point the buyer at it.
      expect(order.paymentUrl).toBe(order.payment?.url);
    });

    it('returns a client secret, and never stores it, in embedded mode', async () => {
      await fillCart();

      const order = await checkout(customerToken, { paymentMode: 'embedded' });

      expect(order.payment?.mode).toBe('embedded');
      expect(order.payment?.clientSecret).toMatch(/_secret$/);
      expect(order.payment?.url).toBeNull();
      expect(order.paymentUrl).toBeNull();

      // The secret exists only in the response that issued it: a client that
      // lost it asks /pay for another, it is never read back out of the order.
      const stored = await orderOf(order.id);
      expect(stored).not.toHaveProperty('clientSecret');
      expect(stored.payment).toBeUndefined();
    });

    it('rejects a checkout mode that is not a mode', async () => {
      await fillCart();

      // Everything else valid on purpose, so the 400 can only be about the
      // mode rather than about the freight fields being absent.
      await http()
        .post('/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          shippingAddress: ADDRESS,
          ...(await quotedShipping(customerToken)),
          paymentMode: 'carrier-pigeon',
        })
        .expect(400);
    });

    it('creates the order anyway when the provider is down, and /pay recovers it', async () => {
      const product = await fillCart();
      stripe.failNextCreate = true;

      const order = await checkout();

      // The transaction committed: stock is gone, the cart is consumed. Only
      // the way to pay is missing, and that is recoverable.
      expect(order.status).toBe(OrderStatus.CREATED);
      expect(order.payment).toBeNull();
      expect(order.paymentRef).toBeNull();
      expect(await stockOf(product.variants[0].id)).toBe(8);

      const recovered = await http()
        .post(`/orders/${order.id}/pay`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({})
        .expect(200);

      const body = recovered.body as OrderResponse;
      expect(body.payment?.url).toContain('checkout.stripe.test');
      expect(body.paymentRef).toMatch(/^cs_test_/);
    });

    it('hands back the open session instead of opening a second one', async () => {
      await fillCart();
      const order = await checkout();

      const again = await http()
        .post(`/orders/${order.id}/pay`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({})
        .expect(200);

      // Same session, not a new one — two open sessions are two ways to
      // charge the same buyer.
      expect((again.body as OrderResponse).paymentRef).toBe(order.paymentRef);
      expect((again.body as OrderResponse).payment?.url).toBe(
        order.payment?.url,
      );
    });

    it('409s /pay when the session was paid but the webhook has not landed', async () => {
      await fillCart();
      const order = await checkout();

      // The buyer pays at the provider; the confirmation is delayed — Stripe
      // backoff, a 429 during a spike, a transient 5xx. The order is therefore
      // STILL `CREATED`, so the status guard alone lets this through.
      stripe.markSessionPaid(order.paymentRef ?? '');

      // Seeing no confirmation, the buyer clicks "pay" again. Before the
      // completed/gone distinction this issued a SECOND payable session and
      // charged them twice, with only the first intent ever recorded.
      await http()
        .post(`/orders/${order.id}/pay`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({})
        .expect(409);

      // Still exactly one session on the order, and none created since.
      expect((await orderOf(order.id)).paymentRef).toBe(order.paymentRef);
      expect((await orderOf(order.id)).status).toBe(OrderStatus.CREATED);

      // ...and the delayed webhook still settles it correctly afterwards.
      await deliver(
        sessionEvent('checkout.session.completed', order.paymentRef ?? ''),
      ).expect(200);
      expect((await orderOf(order.id)).status).toBe(OrderStatus.PAID);
    });

    it('409s /pay on an order that is already paid', async () => {
      await fillCart();
      const order = await payOrder(await checkout());
      expect(order.status).toBe(OrderStatus.PAID);

      await http()
        .post(`/orders/${order.id}/pay`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({})
        .expect(409);
    });

    it("404s another customer's order and lets an operator pay it", async () => {
      await fillCart();
      const order = await checkout();

      await http()
        .post(`/orders/${order.id}/pay`)
        .set('Authorization', `Bearer ${customerBToken}`)
        .send({})
        .expect(404);

      // orders.update_status is the back-office capability here: generating a
      // payment link to send a customer is an operator's job.
      await http()
        .post(`/orders/${order.id}/pay`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({})
        .expect(200);
    });

    it('rate-limits /pay once the per-minute budget is spent', async () => {
      await fillCart();
      const order = await checkout();

      // Issuing a session hits the provider, so the route is throttled. Looping
      // the configured limit + 1 keeps the test honest if the number changes.
      let last = 200;
      for (let i = 0; i < RATE_LIMITS.ISSUE_PAYMENT.limit + 1; i += 1) {
        last = (
          await http()
            .post(`/orders/${order.id}/pay`)
            .set('Authorization', `Bearer ${customerToken}`)
            .send({})
        ).status;
      }

      // The guard is wired, not just declared: drop @UseGuards(ThrottlerGuard)
      // and this is the assertion that fails.
      expect(last).toBe(429);
    });
  });

  describe('webhook', () => {
    it('marks the order PAID and records the provider intent', async () => {
      await fillCart();
      const order = await checkout();

      const paid = await payOrder(order);

      expect(paid.status).toBe(OrderStatus.PAID);
      expect(paid.paidAt).not.toBeNull();
      expect(paid.paymentIntentRef).toMatch(/^pi_test_/);

      // The audit row keeps the provider's own event name, so the trail can
      // tell what actually arrived rather than a generic domain label.
      const recorded = await prisma.paymentEvent.findFirst({
        where: { orderId: order.id },
        select: { type: true, processedAt: true },
      });
      expect(recorded?.type).toBe('checkout.session.completed');
      expect(recorded?.processedAt).not.toBeNull();
    });

    it('processes two simultaneous deliveries of one event exactly once', async () => {
      await fillCart();
      const order = await checkout();
      stripe.markSessionPaid(order.paymentRef ?? '');
      const event = sessionEvent(
        'checkout.session.completed',
        order.paymentRef ?? '',
      );

      // The event-id primary key is layer one of the idempotency, but two
      // deliveries can race past the SELECT — so the conditional UPDATE in
      // markPaid is layer two. Only Postgres can falsify that both hold, which
      // is why this goes through real HTTP into real transactions, like the
      // orders double-checkout test.
      const [a, b] = await Promise.all([deliver(event), deliver(event)]);

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      // Exactly one row, and the order paid once: no double markPaid slipped
      // through the race.
      expect(await prisma.paymentEvent.count()).toBe(1);
      const paid = await orderOf(order.id);
      expect(paid.status).toBe(OrderStatus.PAID);
      expect(paid.paidAt).not.toBeNull();
    });

    it('takes no authentication, unlike the manual mark-paid route', async () => {
      await fillCart();
      const order = await checkout();
      stripe.markSessionPaid(order.paymentRef ?? '');

      // No Authorization header anywhere in deliver(): the signature is the
      // authentication.
      await deliver(
        sessionEvent('checkout.session.completed', order.paymentRef ?? ''),
      ).expect(200);

      // ...which changes nothing about the human route.
      await http()
        .post(`/orders/${order.id}/mark-paid`)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(403);
    });

    it('400s a bad signature and changes nothing', async () => {
      await fillCart();
      const order = await checkout();
      stripe.markSessionPaid(order.paymentRef ?? '');

      const event = sessionEvent(
        'checkout.session.completed',
        order.paymentRef ?? '',
      );

      await deliver(event, 'whsec_not_the_secret').expect(400);
      await http().post('/payments/webhook').send(event).expect(400);

      expect((await orderOf(order.id)).status).toBe(OrderStatus.CREATED);
      expect(await prisma.paymentEvent.count()).toBe(0);
    });

    it('answers a redelivery without paying the order twice', async () => {
      await fillCart();
      const order = await checkout();
      stripe.markSessionPaid(order.paymentRef ?? '');
      const event = sessionEvent(
        'checkout.session.completed',
        order.paymentRef ?? '',
      );

      const first = await deliver(event).expect(200);
      const paidAt = (await orderOf(order.id)).paidAt;

      const second = await deliver(event).expect(200);

      expect((first.body as { duplicate: boolean }).duplicate).toBe(false);
      expect((second.body as { duplicate: boolean }).duplicate).toBe(true);
      expect((await orderOf(order.id)).paidAt).toBe(paidAt);
      expect(await prisma.paymentEvent.count()).toBe(1);
    });

    it('records an event for an order it does not know', async () => {
      await fillCart();
      const order = await checkout();
      stripe.markSessionPaid(order.paymentRef ?? '');
      const event = sessionEvent(
        'checkout.session.completed',
        order.paymentRef ?? '',
      );
      (
        event.data as { object: Record<string, unknown> }
      ).object.client_reference_id = 'order-from-another-galaxy';

      await deliver(event).expect(200);

      expect(await prisma.paymentEvent.count()).toBe(1);
      expect((await orderOf(order.id)).status).toBe(OrderStatus.CREATED);
    });

    it('leaves an order alone when its session merely expires', async () => {
      const product = await fillCart();
      const order = await checkout();

      await deliver(
        sessionEvent('checkout.session.expired', order.paymentRef ?? ''),
      ).expect(200);

      // Deliberate: an expired session is not an abandoned order. The stock
      // stays held and /pay issues another session — automatic cancellation is
      // a decision left to a human (docs/specs/payments.md).
      const after = await orderOf(order.id);
      expect(after.status).toBe(OrderStatus.CREATED);
      expect(await stockOf(product.variants[0].id)).toBe(8);
      expect(await prisma.paymentEvent.count()).toBe(1);
    });

    it('rate-limits the webhook, but generously — a flood, not a sales spike', async () => {
      // The limit is deliberately high (anti-flood, not anti-guess: there is
      // nothing to brute-force in an HMAC), so exhausting it means firing the
      // whole budget plus one. Sequentially rather than in a burst, to avoid a
      // connection storm — the throttler runs as a guard before the handler, so
      // an unsigned body still counts, and the over-budget request 429s where a
      // within-budget one takes the cheap 400 path.
      let last = 0;
      for (let i = 0; i < RATE_LIMITS.PAYMENT_WEBHOOK.limit + 1; i += 1) {
        last = (
          await http()
            .post('/payments/webhook')
            .set('stripe-signature', 'nope')
            .set('content-type', 'application/json')
            .send('{}')
        ).status;
      }

      // The guard is wired, not just declared. A 429 costs nothing here — the
      // provider redelivers with backoff — so refusing the overflow is safe;
      // what must not happen is no limit at all.
      expect(last).toBe(429);
    });
  });

  describe('refund', () => {
    async function paidOrder(): Promise<{
      order: OrderResponse;
      variantId: string;
    }> {
      const product = await fillCart();
      const order = await payOrder(await checkout());

      return { order, variantId: product.variants[0].id };
    }

    it('gives the money back, marks REFUNDED and restocks', async () => {
      const { order, variantId } = await paidOrder();
      expect(await stockOf(variantId)).toBe(8);

      const response = await http()
        .post(`/orders/${order.id}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const refunded = response.body as OrderResponse;
      expect(refunded.status).toBe(OrderStatus.REFUNDED);
      expect(refunded.refundedAt).not.toBeNull();
      expect(refunded.refundRef).toMatch(/^re_test_/);
      // Against the intent, which is the only reference a refund can use.
      expect(stripe.refundsIssued).toEqual([order.paymentIntentRef]);
      expect(await stockOf(variantId)).toBe(10);
    });

    it('is admin-only: an operator and the buyer both get 403', async () => {
      const { order } = await paidOrder();

      await http()
        .post(`/orders/${order.id}/refund`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(403);

      await http()
        .post(`/orders/${order.id}/refund`)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(403);

      expect(stripe.refundsIssued).toEqual([]);
    });

    it('409s an order that was never paid', async () => {
      await fillCart();
      const order = await checkout();

      await http()
        .post(`/orders/${order.id}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);

      expect(stripe.refundsIssued).toEqual([]);
    });

    it('409s an order recorded as paid by hand, without calling the provider', async () => {
      await fillCart();
      const order = await checkout();
      await http()
        .post(`/orders/${order.id}/mark-paid`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);

      // A bank transfer or Pix outside the gateway leaves nothing to reverse.
      const response = await http()
        .post(`/orders/${order.id}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);

      expect(JSON.stringify(response.body)).toContain('manually');
      expect(stripe.refundsIssued).toEqual([]);
    });

    it('refuses to refund twice and restocks only once', async () => {
      const { order, variantId } = await paidOrder();

      await http()
        .post(`/orders/${order.id}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      await http()
        .post(`/orders/${order.id}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);

      expect(await stockOf(variantId)).toBe(10);
      expect(stripe.refundsIssued).toHaveLength(1);
    });

    it('follows a refund issued from the provider dashboard', async () => {
      const { order, variantId } = await paidOrder();

      // A real charge.refunded (frozen fixture) names the intent and nothing of
      // ours — the order is found through the intent it stored when it was paid.
      await deliver(realChargeRefunded(order.paymentIntentRef ?? '')).expect(
        200,
      );

      const refunded = await orderOf(order.id);
      expect(refunded.status).toBe(OrderStatus.REFUNDED);
      expect(refunded.refundedAt).not.toBeNull();
      // Null, faithfully: this API version's charge.refunded carries no refund
      // id, and the status change is the point. The convenience ref is only
      // ever set when our own /refund route issues the reversal.
      expect(refunded.refundRef).toBeNull();
      expect(await stockOf(variantId)).toBe(10);
      // Nothing was sent back to the provider: it started this.
      expect(stripe.refundsIssued).toEqual([]);
    });

    it('ignores a PARTIAL dashboard refund instead of reversing the order', async () => {
      const { order, variantId } = await paidOrder();

      // Support issues a small goodwill credit on a much larger order. Stripe
      // fires charge.refunded for this too, with `refunded: false`. Treating it
      // as a full reversal would mark the order REFUNDED, put every line item
      // back on the shelf — inventory invented from nothing — and leave it
      // unshippable while most of the money is still held.
      const partial = realChargeRefunded(order.paymentIntentRef ?? '');
      const charge = (partial.data as { object: Record<string, unknown> })
        .object;
      charge.refunded = false;
      charge.amount = 50000;
      charge.amount_refunded = 2000;

      await deliver(partial).expect(200);

      const after = await orderOf(order.id);
      expect(after.status).toBe(OrderStatus.PAID);
      expect(after.refundedAt).toBeNull();
      // Stock stays consumed: nothing came back to the shelf.
      expect(await stockOf(variantId)).toBe(8);
      // Recorded, so the trail still shows it arrived.
      expect(await prisma.paymentEvent.count()).toBe(2);
    });

    it('refuses a refund whose payment is not registered yet, so it is redelivered', async () => {
      // A refund carries only the intent, and the intent is recorded by the
      // SUCCESS event — so "no order claims it" nearly always means the two
      // events arrived out of order, not that the payment is foreign.
      // Acknowledging it would stamp the event processed, stop redelivery, and
      // leave the order PAID forever after the money had already gone back.
      await deliver(realChargeRefunded('pi_not_registered_yet')).expect(503);

      const event = await prisma.paymentEvent.findFirst();
      expect(event).not.toBeNull();
      // Seen but unprocessed: the redelivery will find work to do.
      expect(event?.processedAt).toBeNull();
      expect(stripe.refundsIssued).toEqual([]);
    });

    it('settles a refund that overtook its payment once the payment registers', async () => {
      const { order, variantId } = await paidOrder();
      const intent = order.paymentIntentRef ?? '';

      // Same event id both times: the first attempt is refused and left
      // unprocessed, so the redelivery must be allowed through rather than
      // dismissed as a duplicate.
      const refundEvent = realChargeRefunded('pi_not_registered_yet');
      await deliver(refundEvent).expect(503);

      (
        refundEvent.data as { object: Record<string, unknown> }
      ).object.payment_intent = intent;
      await deliver(refundEvent).expect(200);

      const refunded = await orderOf(order.id);
      expect(refunded.status).toBe(OrderStatus.REFUNDED);
      expect(await stockOf(variantId)).toBe(10);
    });
  });

  describe('cancellation', () => {
    it('expires the payment session so a cancelled order stops being payable', async () => {
      await fillCart();
      const order = await checkout();

      await http()
        .post(`/orders/${order.id}/cancel`)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);

      // The stock is back on the shelf and may be sold to someone else, so the
      // old way to pay must stop working.
      expect(stripe.session(order.paymentRef ?? '').status).toBe('expired');
    });
  });
});
