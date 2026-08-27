import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';

import { PasswordService } from '../src/auth/password.service';
import { OrderStatus, ProductStatus } from '../src/generated/prisma/enums';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './support/app';
import { createUserWithRole, resetCatalogTables } from './support/catalog-db';
import { resetAuthTables } from './support/db';
import type { FakeMailService } from './support/fake-mail.service';
import type { OfflineStripe } from './support/offline-stripe';
import { resetOrdersTables } from './support/orders-db';

const PASSWORD = 'correct horse battery staple';

const CUSTOMER_EMAIL = 'order-emails-customer@example.com';

const ADDRESS = {
  line1: 'Rua das Flores, 123',
  city: 'Curitiba',
  state: 'PR',
  postalCode: '80000-000',
};

interface OrderResponse {
  id: string;
  status: OrderStatus;
  itemsSubtotalCents: number;
  shippingCents: number;
  totalCents: number;
  shippingMethodName: string | null;
  paymentRef: string | null;
  paymentIntentRef: string | null;
}

/**
 * Covers docs/specs/order-emails.md at the HTTP level, against the real
 * database — the wiring the unit tests cannot see: that a transition reached
 * from a REQUEST and the same transition reached from a stripe WEBHOOK both
 * produce exactly one email, and that a dead mail provider changes neither
 * status code nor stored state.
 *
 * The fake mail service is the inbox (support/fake-mail.service.ts). It records
 * the view model rather than HTML, so these tests assert what the customer is
 * told; how that becomes markup is pinned down by the template unit tests.
 */
describe('Order emails (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mail: FakeMailService;
  let stripe: OfflineStripe;
  let webhookSecret: string;
  let resetRateLimits: () => void;

  let adminToken: string;
  let operatorToken: string;
  let customerToken: string;

  let eventSequence = 0;

  beforeAll(async () => {
    ({ app, prisma, mail, stripe, webhookSecret, resetRateLimits } =
      await createTestApp());
    const passwords = app.get(PasswordService);
    const passwordHash = await passwords.hash(PASSWORD);

    await resetOrdersTables(prisma);
    await resetAuthTables(prisma);
    await resetCatalogTables(prisma);

    for (const roleName of ['admin', 'operator']) {
      await createUserWithRole(prisma, {
        email: `order-emails-${roleName}@example.com`,
        passwordHash,
        roleName,
      });
    }
    await createUserWithRole(prisma, {
      email: CUSTOMER_EMAIL,
      passwordHash,
      roleName: 'customer',
    });

    adminToken = await login('order-emails-admin@example.com');
    operatorToken = await login('order-emails-operator@example.com');
    customerToken = await login(CUSTOMER_EMAIL);
  });

  beforeEach(async () => {
    await resetOrdersTables(prisma);
    await resetCatalogTables(prisma);
    mail.reset();
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

  /** A cart with one size of one product, ready to check out. */
  async function fillCart(token = customerToken): Promise<{ id: string }> {
    const product = await http()
      .post('/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Camiseta Azul',
        priceCents: 4990,
        status: ProductStatus.ACTIVE,
        variants: [{ label: 'Único', stockQuantity: 10 }],
      })
      .expect(201);

    const { id, variants } = product.body as {
      id: string;
      variants: { id: string }[];
    };

    await http()
      .post('/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ variantId: variants[0].id, quantity: 2 })
      .expect(201);

    return { id };
  }

  /** Checkout the way a storefront does: quote first, then send the code. */
  async function checkout(token = customerToken): Promise<OrderResponse> {
    const quote = await http()
      .post('/shipping/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({ postalCode: ADDRESS.postalCode })
      .expect(200);

    const { options } = quote.body as {
      options: { code: string; priceCents: number }[];
    };

    const response = await http()
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        shippingAddress: ADDRESS,
        shippingOptionCode: options[0].code,
        quotedShippingCents: options[0].priceCents,
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

  /** A CREATED order belonging to the customer. */
  async function createdOrder(): Promise<OrderResponse> {
    await fillCart();

    return checkout();
  }

  /** A PAID order, marked by an operator (the manual-payment route). */
  async function paidOrder(): Promise<OrderResponse> {
    const order = await createdOrder();
    await http()
      .post(`/orders/${order.id}/mark-paid`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    mail.reset();

    return orderOf(order.id);
  }

  function nextEventId(): string {
    eventSequence += 1;

    return `evt_emails_${String(eventSequence)}`;
  }

  /** A provider event, signed exactly the way a real delivery would be. */
  function deliver(event: Record<string, unknown>) {
    const payload = JSON.stringify(event);

    return http()
      .post('/payments/webhook')
      .set('stripe-signature', stripe.sign(payload, webhookSecret))
      .set('content-type', 'application/json')
      .send(payload);
  }

  function sessionEvent(
    sessionId: string,
    id = nextEventId(),
  ): Record<string, unknown> {
    const session = stripe.session(sessionId);

    return {
      id,
      object: 'event',
      type: 'checkout.session.completed',
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

  describe('when an order is paid', () => {
    it('confirms it to the address on the buyer’s account', async () => {
      const order = await createdOrder();

      await http()
        .post(`/orders/${order.id}/mark-paid`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);

      expect(mail.orderPaidEmails).toHaveLength(1);
      expect(mail.orderPaidEmails[0].to).toBe(CUSTOMER_EMAIL);
      expect(mail.orderPaidEmails[0].data.orderId).toBe(order.id);
    });

    it('breaks the freight out instead of hiding it inside the total', async () => {
      const order = await createdOrder();

      await http()
        .post(`/orders/${order.id}/mark-paid`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);

      // The numbers the customer is shown are the numbers the database holds,
      // and they add up — the whole reason the email cannot print totalCents
      // alone now that it includes freight (docs/specs/shipping.md).
      const { data } = mail.orderPaidEmails[0];
      expect(data.itemsSubtotalCents).toBe(order.itemsSubtotalCents);
      expect(data.totalCents).toBe(order.totalCents);
      expect(data.freight).toMatchObject({
        cents: order.shippingCents,
        methodName: order.shippingMethodName,
      });
      expect(data.itemsSubtotalCents + (data.freight?.cents ?? 0)).toBe(
        data.totalCents,
      );
    });

    it('carries the item snapshots and the delivery address', async () => {
      const order = await createdOrder();

      await http()
        .post(`/orders/${order.id}/mark-paid`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);

      const { data } = mail.orderPaidEmails[0];
      expect(data.items).toEqual([
        { productName: 'Camiseta Azul', unitPriceCents: 4990, quantity: 2 },
      ]);
      expect(data.address).toMatchObject({
        line1: ADDRESS.line1,
        city: ADDRESS.city,
        postalCode: ADDRESS.postalCode,
      });
    });

    it('sends nothing the second time the same order is marked paid', async () => {
      const order = await createdOrder();
      const markPaid = () =>
        http()
          .post(`/orders/${order.id}/mark-paid`)
          .set('Authorization', `Bearer ${operatorToken}`);

      await markPaid().expect(200);
      await markPaid().expect(409);

      expect(mail.orderPaidEmails).toHaveLength(1);
    });
  });

  describe('when the payment arrives by webhook', () => {
    /** What paying on the provider's page would produce, without a browser. */
    function payAtProvider(order: OrderResponse): Record<string, unknown> {
      const sessionId = order.paymentRef;
      if (!sessionId) {
        throw new Error('Order has no payment session to pay');
      }
      stripe.markSessionPaid(sessionId);

      return sessionEvent(sessionId);
    }

    it('confirms the order to the customer', async () => {
      const order = await createdOrder();

      await deliver(payAtProvider(order)).expect(200);

      expect(mail.orderPaidEmails).toHaveLength(1);
      expect(mail.orderPaidEmails[0].to).toBe(CUSTOMER_EMAIL);
      expect((await orderOf(order.id)).status).toBe(OrderStatus.PAID);
    });

    it('sends only once when the provider redelivers the same event', async () => {
      const order = await createdOrder();
      const event = payAtProvider(order);

      await deliver(event).expect(200);
      const second = await deliver(event).expect(200);

      // payment_events absorbs it before the domain ever sees it; the row
      // count under markPaid would have stopped it anyway.
      expect(second.body).toMatchObject({ duplicate: true });
      expect(mail.orderPaidEmails).toHaveLength(1);
    });

    it('answers 200 even when the mail provider is down', async () => {
      const order = await createdOrder();
      const event = payAtProvider(order);
      mail.failNextSend = true;

      // The rule this protects: any non-2xx makes Stripe redeliver for days,
      // so a Resend outage would turn into a redelivery storm over a payment
      // that was already applied.
      await deliver(event).expect(200);

      expect(mail.orderPaidEmails).toHaveLength(0);
      expect((await orderOf(order.id)).status).toBe(OrderStatus.PAID);
    });
  });

  describe('when an order ships', () => {
    it('sends the tracking details it was just stamped with', async () => {
      const order = await paidOrder();

      await http()
        .post(`/orders/${order.id}/ship`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({
          trackingCode: 'BR123456789BR',
          trackingUrl: 'https://rastreio.example.com/BR123456789BR',
        })
        .expect(200);

      expect(mail.orderShippedEmails).toHaveLength(1);
      expect(mail.orderShippedEmails[0].data).toMatchObject({
        trackingCode: 'BR123456789BR',
        trackingUrl: 'https://rastreio.example.com/BR123456789BR',
      });
    });

    it('still tells the customer when there is no tracking to give', async () => {
      const order = await paidOrder();

      // A courier or a hand-off arranged by phone is a real shipment.
      await http()
        .post(`/orders/${order.id}/ship`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({})
        .expect(200);

      expect(mail.orderShippedEmails).toHaveLength(1);
      expect(mail.orderShippedEmails[0].data).toMatchObject({
        trackingCode: null,
        trackingUrl: null,
      });
    });

    it('sends nothing on a second ship of the same order', async () => {
      const order = await paidOrder();
      const ship = () =>
        http()
          .post(`/orders/${order.id}/ship`)
          .set('Authorization', `Bearer ${operatorToken}`)
          .send({});

      await ship().expect(200);
      await ship().expect(409);

      expect(mail.orderShippedEmails).toHaveLength(1);
    });
  });

  describe('when an order is delivered', () => {
    it('sends nothing at all', async () => {
      const order = await paidOrder();
      await http()
        .post(`/orders/${order.id}/ship`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({})
        .expect(200);
      mail.reset();

      await http()
        .post(`/orders/${order.id}/deliver`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);

      // Deliberate: the box is already in the customer's hands.
      expect(mail.orderPaidEmails).toHaveLength(0);
      expect(mail.orderShippedEmails).toHaveLength(0);
      expect(mail.orderRefundedEmails).toHaveLength(0);
      expect(mail.orderCancelledEmails).toHaveLength(0);
    });
  });

  describe('when an order is refunded', () => {
    /** Paid through the provider, so there is an intent to refund against. */
    async function providerPaidOrder(): Promise<OrderResponse> {
      const order = await createdOrder();
      const sessionId = order.paymentRef;
      if (!sessionId) {
        throw new Error('Order has no payment session to pay');
      }
      stripe.markSessionPaid(sessionId);
      await deliver(sessionEvent(sessionId)).expect(200);
      mail.reset();

      return orderOf(order.id);
    }

    it('tells the customer the money is on its way back', async () => {
      const order = await providerPaidOrder();

      await http()
        .post(`/orders/${order.id}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(mail.orderRefundedEmails).toHaveLength(1);
      expect(mail.orderRefundedEmails[0].to).toBe(CUSTOMER_EMAIL);
      expect(mail.orderRefundedEmails[0].data.totalCents).toBe(
        order.totalCents,
      );
    });

    it('does not send twice when the provider event follows the route', async () => {
      const order = await providerPaidOrder();

      await http()
        .post(`/orders/${order.id}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // charge.refunded lands afterwards for the refund we just issued. The
      // order is no longer PAID, markRefunded returns false, nothing is sent.
      const intentRef = (await orderOf(order.id)).paymentIntentRef;
      await deliver({
        id: nextEventId(),
        object: 'event',
        type: 'charge.refunded',
        data: {
          object: {
            object: 'charge',
            payment_intent: intentRef,
            refunded: true,
          },
        },
      }).expect(200);

      expect(mail.orderRefundedEmails).toHaveLength(1);
    });
  });

  describe('when an order is cancelled', () => {
    it('stays quiet when customers cancel their own order', async () => {
      const order = await createdOrder();

      await http()
        .post(`/orders/${order.id}/cancel`)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);

      // They are reading the 200 for this very request.
      expect(mail.orderCancelledEmails).toHaveLength(0);
    });

    it('warns the customer when an admin cancels it for them', async () => {
      const order = await createdOrder();

      await http()
        .post(`/orders/${order.id}/cancel`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // The only cancellation the customer could not have known about.
      expect(mail.orderCancelledEmails).toHaveLength(1);
      expect(mail.orderCancelledEmails[0].to).toBe(CUSTOMER_EMAIL);
      expect(mail.orderCancelledEmails[0].data.orderId).toBe(order.id);
    });
  });

  describe('when the mail provider is down', () => {
    it('marks the order paid anyway', async () => {
      const order = await createdOrder();
      mail.failNextSend = true;

      await http()
        .post(`/orders/${order.id}/mark-paid`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);

      // Same invariant as AuthService.register: the operation is real, and
      // only the notification was lost (docs/specs/auth.md).
      expect(mail.orderPaidEmails).toHaveLength(0);
      expect((await orderOf(order.id)).status).toBe(OrderStatus.PAID);
    });

    it('ships the order anyway', async () => {
      const order = await paidOrder();
      mail.failNextSend = true;

      await http()
        .post(`/orders/${order.id}/ship`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ trackingCode: 'BR123456789BR' })
        .expect(200);

      expect(mail.orderShippedEmails).toHaveLength(0);
      expect((await orderOf(order.id)).status).toBe(OrderStatus.SHIPPED);
    });
  });
});
