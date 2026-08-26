import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';

import { PasswordService } from '../src/auth/password.service';
import { OrderStatus } from '../src/generated/prisma/enums';
import { RATE_LIMITS } from '../src/orders/rate-limits';
import { PrismaService } from '../src/prisma/prisma.service';
import { DEFAULT_SHIPPING_TABLE } from '../src/shipping/shipping-table';
import { createTestApp } from './support/app';
import { createUserWithRole, resetCatalogTables } from './support/catalog-db';
import { resetAuthTables } from './support/db';
import type { OfflineStripe } from './support/offline-stripe';
import { resetOrdersTables } from './support/orders-db';

const PASSWORD = 'correct horse battery staple';

/** 80000-000 is Curitiba — prefix '8', so the built-in table's Brazil option. */
const ADDRESS = {
  line1: 'Rua das Flores, 123',
  city: 'Curitiba',
  state: 'PR',
  postalCode: '80000-000',
};

/**
 * The prices this suite asserts come from the table the app actually boots
 * with in test (SHIPPING_TABLE is unset, so DEFAULT_SHIPPING_TABLE applies).
 * Read from it rather than copied, so editing the table cannot leave these
 * tests asserting numbers the store no longer charges.
 */
const BRASIL = DEFAULT_SHIPPING_TABLE.find(
  (option) => option.code === 'padrao-brasil',
);

if (!BRASIL) {
  throw new Error('The built-in freight table lost its padrao-brasil option');
}

/** Freight for a parcel of exactly one default-weight (500 g) product. */
const ONE_LIGHT_PARCEL_CENTS = BRASIL.rates[0].priceCents;

interface ShippingOptionResponse {
  code: string;
  label: string;
  priceCents: number;
  estimatedDays: number | null;
  carrier: string | null;
  orderTotalCents: number;
}

interface ShippingQuoteResponse {
  options: ShippingOptionResponse[];
  itemsSubtotalCents: number;
}

interface OrderResponse {
  id: string;
  status: OrderStatus;
  itemsSubtotalCents: number;
  shippingCents: number;
  totalCents: number;
  shippingMethodCode: string | null;
  shippingMethodName: string | null;
  shippingEtaDays: number | null;
  trackingCode: string | null;
  trackingUrl: string | null;
  paymentRef: string | null;
}

/**
 * Covers docs/specs/shipping.md at the HTTP level, against the real database.
 *
 * Unlike payments, there is no third party to stand in for: TableShippingProvider
 * is the real v1 provider and runs here exactly as it runs in production, so
 * this suite exercises the whole module rather than a double of it. What it
 * cannot prove is that a CARRIER would fit behind the same interface — that
 * remains an argument, recorded as a known gap in the spec.
 *
 * The assertion that matters most is the last one in "money": that Stripe is
 * asked for items PLUS freight. Everything else in this module exists to make
 * that number right.
 */
describe('Shipping (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let stripe: OfflineStripe;
  let resetRateLimits: () => void;

  let adminToken: string;
  let customerToken: string;

  beforeAll(async () => {
    ({ app, prisma, stripe, resetRateLimits } = await createTestApp());
    const passwords = app.get(PasswordService);
    const passwordHash = await passwords.hash(PASSWORD);

    await resetOrdersTables(prisma);
    await resetAuthTables(prisma);
    await resetCatalogTables(prisma);

    for (const roleName of ['admin', 'customer']) {
      await createUserWithRole(prisma, {
        email: `shipping-${roleName}@example.com`,
        passwordHash,
        roleName,
      });
    }

    adminToken = await login('shipping-admin@example.com');
    customerToken = await login('shipping-customer@example.com');
  });

  beforeEach(async () => {
    await resetOrdersTables(prisma);
    await resetCatalogTables(prisma);
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

  async function createProduct(
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    const response = await http()
      .post('/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Camiseta',
        priceCents: 5000,
        status: 'ACTIVE',
        stockQuantity: 10,
        ...overrides,
      })
      .expect(201);

    return response.body as { id: string };
  }

  async function fillCart(
    quantity = 1,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    const product = await createProduct(overrides);

    await http()
      .post('/cart/items')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ productId: product.id, quantity })
      .expect(201);

    return product;
  }

  async function quoteBody(
    postalCode = ADDRESS.postalCode,
    token = customerToken,
    expected = 200,
  ): Promise<ShippingQuoteResponse> {
    const response = await http()
      .post('/shipping/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({ postalCode })
      .expect(expected);

    return response.body as ShippingQuoteResponse;
  }

  async function quote(
    postalCode = ADDRESS.postalCode,
    token = customerToken,
    expected = 200,
  ): Promise<ShippingOptionResponse[]> {
    return (await quoteBody(postalCode, token, expected)).options;
  }

  function checkout(body: Record<string, unknown>) {
    return http()
      .post('/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ shippingAddress: ADDRESS, ...body });
  }

  /** The storefront's normal path: quote, then buy what was quoted. */
  async function quotedCheckout(
    overrides: Record<string, unknown> = {},
  ): Promise<OrderResponse> {
    const [option] = await quote();
    const response = await checkout({
      shippingOptionCode: option.code,
      quotedShippingCents: option.priceCents,
      ...overrides,
    }).expect(201);

    return response.body as OrderResponse;
  }

  describe('quoting', () => {
    it('prices the caller`s cart for a served postal code', async () => {
      await fillCart();

      const options = await quote();

      expect(options).not.toHaveLength(0);
      expect(options[0]).toEqual({
        code: 'padrao-brasil',
        label: expect.any(String) as string,
        priceCents: ONE_LIGHT_PARCEL_CENTS,
        estimatedDays: expect.any(Number) as number,
        carrier: null,
        orderTotalCents: 5000 + ONE_LIGHT_PARCEL_CENTS,
      });
    });

    it('serves every Brazilian region out of the built-in table', async () => {
      await fillCart();

      // The CEP's own first digit partitions the country, and the shipped
      // table covers 0-9 — so a fresh clone can sell anywhere, and the empty
      // list below has to be produced by weight rather than by address.
      for (const postalCode of [
        '01000-000',
        '20000-000',
        '30000-000',
        '40000-000',
        '50000-000',
        '60000-000',
        '70000-000',
        '80000-000',
        '90000-000',
      ]) {
        await expect(quote(postalCode)).resolves.not.toHaveLength(0);
      }
    });

    it('returns an empty list, not an error, when nothing can carry the parcel', async () => {
      // Past the table's ceiling: 10 × 20 kg. "Nothing available" is an
      // answer, and the caller turns it into a 409 at checkout.
      await fillCart(10, { weightGrams: 20_000 });

      const body = await quoteBody();

      expect(body.options).toEqual([]);
      // The subtotal describes the cart, not the delivery — it survives the
      // absence of any option to deliver it.
      expect(body.itemsSubtotalCents).toBe(50_000);
    });

    it('uses a real product weight when it has one', async () => {
      await fillCart(1, { weightGrams: 9_000 });

      const [option] = await quote();

      // 9 kg lands in a heavier bracket than the 500 g default would.
      expect(option.priceCents).toBeGreaterThan(ONE_LIGHT_PARCEL_CENTS);
    });

    it('400s a malformed CEP, 409s an empty cart, 401s without a token', async () => {
      await fillCart();
      await quote('123', customerToken, 400);

      await resetOrdersTables(prisma);
      await quote(ADDRESS.postalCode, customerToken, 409);

      await http()
        .post('/shipping/quote')
        .send({ postalCode: ADDRESS.postalCode })
        .expect(401);
    });

    it('prices a hyphenated and a bare CEP the same', async () => {
      await fillCart();

      const [withHyphen] = await quote('80000-000');
      const [without] = await quote('80000000');

      expect(withHyphen).toEqual(without);
    });
  });

  describe('money', () => {
    it('reports the cart subtotal and an order total per option', async () => {
      await fillCart(2);

      const body = await quoteBody();

      expect(body.itemsSubtotalCents).toBe(10_000);
      for (const option of body.options) {
        // What a checkout button renders, before any order exists.
        expect(option.orderTotalCents).toBe(
          body.itemsSubtotalCents + option.priceCents,
        );
      }
    });

    it('quotes exactly the total the order is then created with', async () => {
      await fillCart(2);

      const body = await quoteBody();
      const [option] = body.options;

      const response = await checkout({
        shippingOptionCode: option.code,
        quotedShippingCents: option.priceCents,
      }).expect(201);
      const order = response.body as OrderResponse;

      // The assertion that makes orderTotalCents worth having: the number the
      // storefront put on the button IS the number the order was created for.
      // Any drift between these two is a bug, and this is where it shows.
      expect(order.totalCents).toBe(option.orderTotalCents);
      expect(order.itemsSubtotalCents).toBe(body.itemsSubtotalCents);
    });

    it('adds freight to the total and freezes the method', async () => {
      await fillCart();

      const order = await quotedCheckout();

      expect(order.itemsSubtotalCents).toBe(5000);
      expect(order.shippingCents).toBe(ONE_LIGHT_PARCEL_CENTS);
      expect(order.totalCents).toBe(5000 + ONE_LIGHT_PARCEL_CENTS);
      expect(order.shippingMethodCode).toBe('padrao-brasil');
      expect(order.shippingMethodName).toEqual(expect.any(String));
      expect(order.shippingEtaDays).toEqual(expect.any(Number));
    });

    it('charges items PLUS freight at the payment provider', async () => {
      await fillCart();

      const order = await quotedCheckout();

      // The one assertion this whole module exists for. The session was built
      // by the real StripePaymentProvider; only the network is doubled, so
      // this is the amount that would reach a real card.
      const session = stripe.session(order.paymentRef ?? '');
      expect(session.amount_total).toBe(5000 + ONE_LIGHT_PARCEL_CENTS);
      expect(session.amount_total).toBe(order.totalCents);
    });

    it('holds the total = items + freight identity in the database itself', async () => {
      await fillCart(2);

      const order = await quotedCheckout();

      // Read back from Postgres rather than the response: the CHECK
      // constraint is the guarantee that outlives this code.
      const stored = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        select: {
          itemsSubtotalCents: true,
          shippingCents: true,
          totalCents: true,
        },
      });
      expect(stored.totalCents).toBe(
        stored.itemsSubtotalCents + stored.shippingCents,
      );
    });
  });

  describe('the quoted price is the charged price', () => {
    it('409s when the asserted freight does not match, changing nothing', async () => {
      const product = await fillCart();
      const [option] = await quote();

      const response = await checkout({
        shippingOptionCode: option.code,
        // What a tampered request looks like — and equally what a stale
        // storefront would send after the table changed.
        quotedShippingCents: 1,
      }).expect(409);

      expect(response.body).toMatchObject({
        shippingOptions: expect.arrayContaining([
          expect.objectContaining({ code: option.code }),
        ]) as unknown,
      });
      await expect(prisma.order.count()).resolves.toBe(0);
      const stored = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
        select: { stockQuantity: true },
      });
      // Nothing was decremented: the refusal happens before the transaction.
      expect(stored.stockQuantity).toBe(10);
    });

    it('refuses a zero-freight assertion outright', async () => {
      await fillCart();
      const [option] = await quote();

      await checkout({
        shippingOptionCode: option.code,
        quotedShippingCents: 0,
      }).expect(409);
      await expect(prisma.order.count()).resolves.toBe(0);
    });

    it('409s an option code that is not on offer', async () => {
      await fillCart();

      await checkout({
        shippingOptionCode: 'expressa-lua',
        quotedShippingCents: ONE_LIGHT_PARCEL_CENTS,
      }).expect(409);
      await expect(prisma.order.count()).resolves.toBe(0);
    });

    it('409s when no option can serve the cart at all', async () => {
      await fillCart(10, { weightGrams: 20_000 });

      const response = await checkout({
        shippingOptionCode: 'padrao-brasil',
        quotedShippingCents: ONE_LIGHT_PARCEL_CENTS,
      }).expect(409);

      expect(response.body).toMatchObject({
        message: expect.stringMatching(
          /No delivery option is available/,
        ) as unknown,
        shippingOptions: [],
      });
      await expect(prisma.order.count()).resolves.toBe(0);
    });

    it('400s a checkout with a malformed CEP or missing freight fields', async () => {
      await fillCart();

      await checkout({
        shippingOptionCode: 'padrao-brasil',
        quotedShippingCents: ONE_LIGHT_PARCEL_CENTS,
        shippingAddress: { ...ADDRESS, postalCode: 'CEP' },
      }).expect(400);

      // The assertion is required, not optional: a checkout that forgets it
      // must not fall through to "charge whatever".
      await checkout({ shippingOptionCode: 'padrao-brasil' }).expect(400);
      await checkout({ quotedShippingCents: ONE_LIGHT_PARCEL_CENTS }).expect(
        400,
      );
      await expect(prisma.order.count()).resolves.toBe(0);
    });

    it('rejects a freight price the cart no longer supports', async () => {
      await fillCart();
      const [light] = await quote();

      // The cart grows heavier after the quote, so the freight the customer
      // saw no longer applies. Same mechanism as a table edit.
      await fillCart(1, { weightGrams: 9_000 });

      await checkout({
        shippingOptionCode: light.code,
        quotedShippingCents: light.priceCents,
      }).expect(409);
      await expect(prisma.order.count()).resolves.toBe(0);
    });
  });

  describe('tracking', () => {
    it('stamps a tracking code on ship, and reads it back', async () => {
      await fillCart();
      const order = await quotedCheckout();
      await http()
        .post(`/orders/${order.id}/mark-paid`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const shipped = await http()
        .post(`/orders/${order.id}/ship`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          trackingCode: 'BR123456789BR',
          trackingUrl: 'https://rastreio.example/BR123456789BR',
        })
        .expect(200);

      const body = shipped.body as OrderResponse;
      expect(body.status).toBe(OrderStatus.SHIPPED);
      expect(body.trackingCode).toBe('BR123456789BR');
      expect(body.trackingUrl).toBe('https://rastreio.example/BR123456789BR');
    });

    it('ships with no tracking at all', async () => {
      await fillCart();
      const order = await quotedCheckout();
      await http()
        .post(`/orders/${order.id}/mark-paid`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // A courier or a local hand-off has no code, and that is a real
      // shipment — the transition must not require one.
      const shipped = await http()
        .post(`/orders/${order.id}/ship`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(200);

      const body = shipped.body as OrderResponse;
      expect(body.status).toBe(OrderStatus.SHIPPED);
      expect(body.trackingCode).toBeNull();
    });

    it('400s a tracking URL that is not a URL', async () => {
      await fillCart();
      const order = await quotedCheckout();
      await http()
        .post(`/orders/${order.id}/mark-paid`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      await http()
        .post(`/orders/${order.id}/ship`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ trackingUrl: 'not a url' })
        .expect(400);
    });
  });

  describe('rate limiting', () => {
    it('429s past the quote budget', async () => {
      await fillCart();

      // The budget is spent on requests that never reach the handler: guards
      // run ahead of pipes, so a body the ValidationPipe rejects still counts
      // against the limit while skipping the cart and catalog reads. Thirty
      // cheap round trips instead of thirty full quotes — and the assertion
      // that follows is the stronger one, because what gets refused is a
      // perfectly valid request, purely for being over budget.
      for (let i = 0; i < RATE_LIMITS.SHIPPING_QUOTE.limit; i += 1) {
        await http()
          .post('/shipping/quote')
          .set('Authorization', `Bearer ${customerToken}`)
          .send({})
          .expect(400);
      }

      // The guard is wired, not merely declared — drop @UseGuards from the
      // controller and this is the assertion that fails.
      await quote(ADDRESS.postalCode, customerToken, 429);
    }, 120_000); // a hosted database, do not fit the suite's default 30s. // Thirty-one authenticated round trips, each resolving permissions from
  });
});
