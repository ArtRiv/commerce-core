import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';

import { PasswordService } from '../src/auth/password.service';
import { OrderStatus, ProductStatus } from '../src/generated/prisma/enums';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './support/app';
import { createUserWithRole, resetCatalogTables } from './support/catalog-db';
import { resetAuthTables } from './support/db';
import { resetOrdersTables } from './support/orders-db';

const PASSWORD = 'correct horse battery staple';

/**
 * Forced before the app is built, exactly like the Stripe keys in
 * support/app.ts: ConfigModule loads .env without overriding what is already
 * in the environment, so this wins over whatever the developer configured.
 *
 * The suite needs a zone with a real offset, because the whole point of
 * invariant 4 is that UTC and the store's clock disagree about which month a
 * late-night sale belongs to.
 */
const STORE_TIME_ZONE = 'America/Sao_Paulo';

interface ProductResponse {
  id: string;
  name: string;
  slug: string;
  status: ProductStatus;
  variants: { id: string; label: string; stockQuantity: number }[];
}

interface ProductSalesReport {
  from: string;
  to: string;
  items: {
    productId: string;
    name: string;
    slug: string;
    unitsSold: number;
    itemsRevenueCents: number;
    orderCount: number;
  }[];
  total: number;
  page: number;
  perPage: number;
}

interface RevenueReport {
  granularity: string;
  timeZone: string;
  buckets: {
    periodStart: string;
    revenueCents: number;
    itemsSubtotalCents: number;
    shippingCents: number;
    orderCount: number;
  }[];
}

interface CartsReport {
  unitCount: number;
  lineCount: number;
  cartCount: number;
}

interface UnsoldProductsReport {
  items: {
    productId: string;
    name: string;
    stockQuantity: number;
    lastSoldAt: string | null;
  }[];
  total: number;
}

/**
 * Covers docs/specs/reports.md at the HTTP level, against the real database.
 *
 * The unit tests prove the mapping and what gets BOUND to each query — that a
 * CREATED order never reaches the database as something to count. What only a
 * real Postgres can falsify is the SQL itself, and three claims in particular:
 *
 *  - `date_trunc` over a naive TIMESTAMP puts a late-night sale in the month
 *    the STORE was having, not the one UTC was;
 *  - the series has no gaps, so a quiet week is zeros rather than absence;
 *  - "not moving" really is the complement of "sold", against the same rows.
 *
 * Orders are written straight to the database rather than checked out, and
 * that is deliberate: `paidAt` is stamped by the state machine and no route
 * can backdate it, so a suite driving checkout could only ever report on
 * today. The report is what is under test here; checkout is covered by its
 * own suite.
 */
describe('Reports (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let resetRateLimits: () => void;

  let adminToken: string;
  let operatorToken: string;
  let customerToken: string;
  let customerId: string;

  beforeAll(async () => {
    process.env.REPORTS_TIMEZONE = STORE_TIME_ZONE;

    ({ app, prisma, resetRateLimits } = await createTestApp());
    const passwords = app.get(PasswordService);
    const passwordHash = await passwords.hash(PASSWORD);

    await resetOrdersTables(prisma);
    await resetCatalogTables(prisma);
    await resetAuthTables(prisma);

    await createUserWithRole(prisma, {
      email: 'reports-admin@example.com',
      passwordHash,
      roleName: 'admin',
    });
    // The role that actually holds reports.read without holding everything.
    await createUserWithRole(prisma, {
      email: 'reports-operator@example.com',
      passwordHash,
      roleName: 'operator',
    });
    const customer = await createUserWithRole(prisma, {
      email: 'reports-customer@example.com',
      passwordHash,
      roleName: 'customer',
    });
    customerId = customer.id;

    adminToken = await login('reports-admin@example.com');
    operatorToken = await login('reports-operator@example.com');
    customerToken = await login('reports-customer@example.com');
  });

  beforeEach(async () => {
    // Orders first: order_items Restrict product deletion.
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

  /** ACTIVE from birth, so it is a candidate for every report here. */
  async function createProduct(
    name: string,
    labels: string[],
    priceCents = 7990,
    stock = 10,
  ): Promise<ProductResponse> {
    const created = await http()
      .post('/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name,
        priceCents,
        status: ProductStatus.ACTIVE,
        variants: labels.map((label) => ({ label, stockQuantity: stock })),
      })
      .expect(201);

    return created.body as ProductResponse;
  }

  interface OrderLine {
    product: ProductResponse;
    /** Index into the product's variants. */
    variant?: number;
    quantity?: number;
    unitPriceCents?: number;
  }

  /**
   * An order in a chosen state, at a chosen instant.
   *
   * `paidAt` is set for every status that has been through PAID, which is what
   * the state machine guarantees and therefore what the reports may assume.
   */
  async function placeOrder(
    lines: OrderLine[],
    {
      status = OrderStatus.PAID,
      paidAt,
      shippingCents = 1990,
    }: {
      status?: OrderStatus;
      paidAt?: string;
      shippingCents?: number;
    } = {},
  ): Promise<string> {
    const items = lines.map((line) => {
      const variant = line.product.variants[line.variant ?? 0];

      return {
        productId: line.product.id,
        variantId: variant.id,
        productName: line.product.name,
        variantLabel: variant.label,
        unitPriceCents: line.unitPriceCents ?? 7990,
        quantity: line.quantity ?? 1,
      };
    });

    const itemsSubtotalCents = items.reduce(
      (sum, item) => sum + item.unitPriceCents * item.quantity,
      0,
    );

    const wasEverPaid =
      status !== OrderStatus.CREATED && status !== OrderStatus.CANCELLED;

    const order = await prisma.order.create({
      data: {
        userId: customerId,
        status,
        itemsSubtotalCents,
        shippingCents,
        totalCents: itemsSubtotalCents + shippingCents,
        paidAt: wasEverPaid
          ? new Date(paidAt ?? '2026-08-10T12:00:00.000Z')
          : null,
        shippingLine1: 'Rua das Flores, 123',
        shippingCity: 'Curitiba',
        shippingState: 'PR',
        shippingPostalCode: '80000-000',
        items: { create: items },
      },
      select: { id: true },
    });

    return order.id;
  }

  function get(path: string, token = operatorToken) {
    return http().get(path).set('Authorization', `Bearer ${token}`);
  }

  const AUGUST = 'from=2026-08-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z';

  const ROUTES = [
    '/reports/product-sales',
    '/reports/revenue',
    '/reports/carts',
    '/reports/unsold-products',
  ];

  describe('who may ask', () => {
    it.each(ROUTES)('refuses %s without a token', async (route) => {
      await http().get(route).expect(401);
    });

    /**
     * 403, not 404. The house pattern of answering 404 protects the existence
     * of a RESOURCE from being confirmed to whoever probes an id; no route
     * here takes an id, so there is nothing whose existence could leak.
     *
     * The body does not name the permission, and should not: the guard says
     * one thing for every route, and which permission was missing is
     * documented in the operation's 403 rather than handed to whoever was
     * refused. That the document names `reports.read` is asserted by
     * src/openapi/document.spec.ts, against the same metadata this guard
     * reads.
     */
    it.each(ROUTES)(
      'refuses %s to a plain customer with 403',
      async (route) => {
        const response = await get(route, customerToken).expect(403);

        expect((response.body as { message: string }).message).toBe(
          'Insufficient permissions',
        );
      },
    );

    it.each(ROUTES)('answers %s to an operator', async (route) => {
      await get(route).expect(200);
    });

    it.each(ROUTES)('answers %s to an admin', async (route) => {
      await get(route, adminToken).expect(200);
    });
  });

  describe('the window', () => {
    it.each([
      '/reports/product-sales',
      '/reports/revenue',
      '/reports/unsold-products',
    ])('refuses a start at or after the end on %s', async (route) => {
      await get(
        `${route}?from=2026-09-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z`,
      ).expect(400);

      await get(
        `${route}?from=2026-08-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z`,
      ).expect(400);
    });

    it('refuses a date it cannot parse', async () => {
      await get('/reports/product-sales?from=last%20tuesday').expect(400);
    });

    it('defaults to the last 30 days and says which they were', async () => {
      const before = Date.now();
      const response = await get('/reports/product-sales').expect(200);
      const report = response.body as ProductSalesReport;

      const from = Date.parse(report.from);
      const to = Date.parse(report.to);

      expect(to).toBeGreaterThanOrEqual(before);
      expect(to - from).toBe(30 * 24 * 60 * 60 * 1000);
    });
  });

  describe('what counts as a sale', () => {
    /**
     * The assertion the whole module rests on, made against real rows: five
     * orders for the same piece, one in each state, and only three are money.
     */
    it('counts PAID, SHIPPED and DELIVERED — and nothing else', async () => {
      const shirt = await createProduct('Camiseta Preta', ['P', 'M']);

      for (const status of [
        OrderStatus.PAID,
        OrderStatus.SHIPPED,
        OrderStatus.DELIVERED,
        OrderStatus.CREATED,
        OrderStatus.CANCELLED,
        OrderStatus.REFUNDED,
      ]) {
        await placeOrder([{ product: shirt, quantity: 2 }], { status });
      }

      const response = await get(`/reports/product-sales?${AUGUST}`).expect(
        200,
      );
      const report = response.body as ProductSalesReport;

      expect(report.items).toHaveLength(1);
      // Three orders of two units, not six orders of two.
      expect(report.items[0].unitsSold).toBe(6);
      expect(report.items[0].orderCount).toBe(3);
      expect(report.items[0].itemsRevenueCents).toBe(3 * 2 * 7990);
    });

    it('leaves out a sale that fell outside the window', async () => {
      const shirt = await createProduct('Camiseta Preta', ['Único']);
      await placeOrder([{ product: shirt }], {
        paidAt: '2026-07-15T12:00:00.000Z',
      });

      const response = await get(`/reports/product-sales?${AUGUST}`).expect(
        200,
      );

      expect((response.body as ProductSalesReport).items).toEqual([]);
    });

    /** `to` is exclusive, which is what stops two months double-counting. */
    it('excludes an order paid exactly at the end of the window', async () => {
      const shirt = await createProduct('Camiseta Preta', ['Único']);
      await placeOrder([{ product: shirt }], {
        paidAt: '2026-09-01T00:00:00.000Z',
      });

      const response = await get(`/reports/product-sales?${AUGUST}`).expect(
        200,
      );

      expect((response.body as ProductSalesReport).items).toEqual([]);
    });
  });

  describe('units per piece', () => {
    it('sums the sizes of one piece into a single line', async () => {
      const shirt = await createProduct('Camiseta Preta', ['P', 'M']);
      await placeOrder([
        { product: shirt, variant: 0, quantity: 2 },
        { product: shirt, variant: 1, quantity: 3 },
      ]);

      const response = await get(`/reports/product-sales?${AUGUST}`).expect(
        200,
      );
      const report = response.body as ProductSalesReport;

      expect(report.items).toHaveLength(1);
      expect(report.items[0].unitsSold).toBe(5);
      expect(report.items[0].orderCount).toBe(1);
    });

    /**
     * The reason the query groups by product id and joins the catalogue
     * instead of grouping by the order's productName snapshot: the snapshot
     * would split this piece into two lines.
     */
    it('keeps a renamed piece as one line, under the name it has now', async () => {
      const shirt = await createProduct('Camiseta Preta', ['Único']);
      await placeOrder([{ product: shirt, quantity: 2 }], {
        paidAt: '2026-08-05T12:00:00.000Z',
      });

      await http()
        .patch(`/products/${shirt.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Camiseta Grafite' })
        .expect(200);

      await placeOrder([{ product: shirt, quantity: 1 }], {
        paidAt: '2026-08-20T12:00:00.000Z',
      });

      const response = await get(`/reports/product-sales?${AUGUST}`).expect(
        200,
      );
      const report = response.body as ProductSalesReport;

      expect(report.items).toHaveLength(1);
      expect(report.items[0].name).toBe('Camiseta Grafite');
      expect(report.items[0].unitsSold).toBe(3);
    });

    it('orders best-selling first and paginates', async () => {
      const shirt = await createProduct('Camiseta Preta', ['Único']);
      const trousers = await createProduct('Calça Cargo', ['Único']);

      await placeOrder([{ product: shirt, quantity: 1 }]);
      await placeOrder([{ product: trousers, quantity: 5 }]);

      const first = await get(
        `/reports/product-sales?${AUGUST}&perPage=1`,
      ).expect(200);
      const page = first.body as ProductSalesReport;

      expect(page.items).toHaveLength(1);
      expect(page.items[0].name).toBe('Calça Cargo');
      expect(page.total).toBe(2);

      const second = await get(
        `/reports/product-sales?${AUGUST}&perPage=1&page=2`,
      ).expect(200);

      expect((second.body as ProductSalesReport).items[0].name).toBe(
        'Camiseta Preta',
      );
    });

    it('answers a quiet period with an empty page', async () => {
      await createProduct('Camiseta Preta', ['Único']);

      const response = await get(`/reports/product-sales?${AUGUST}`).expect(
        200,
      );
      const report = response.body as ProductSalesReport;

      expect(report.items).toEqual([]);
      expect(report.total).toBe(0);
    });
  });

  describe('revenue', () => {
    const QUARTER = 'from=2026-07-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z';

    it('sums the charged total, broken into goods and freight', async () => {
      const shirt = await createProduct('Camiseta Preta', ['Único']);
      await placeOrder([{ product: shirt, quantity: 2 }], {
        paidAt: '2026-08-10T12:00:00.000Z',
        shippingCents: 1990,
      });

      const response = await get(
        `/reports/revenue?${AUGUST}&granularity=month`,
      ).expect(200);
      const report = response.body as RevenueReport;

      const august = report.buckets.find((b) => b.periodStart === '2026-08-01');

      expect(august).toBeDefined();
      expect(august?.itemsSubtotalCents).toBe(2 * 7990);
      expect(august?.shippingCents).toBe(1990);
      expect(august?.revenueCents).toBe(2 * 7990 + 1990);
      expect(august?.orderCount).toBe(1);
    });

    it('keeps revenue equal to goods plus freight in every bucket', async () => {
      const shirt = await createProduct('Camiseta Preta', ['Único']);
      await placeOrder([{ product: shirt }], {
        paidAt: '2026-07-10T12:00:00.000Z',
      });
      await placeOrder([{ product: shirt }], {
        paidAt: '2026-09-10T12:00:00.000Z',
      });

      const response = await get(
        `/reports/revenue?${QUARTER}&granularity=month`,
      ).expect(200);

      for (const bucket of (response.body as RevenueReport).buckets) {
        expect(bucket.revenueCents).toBe(
          bucket.itemsSubtotalCents + bucket.shippingCents,
        );
      }
    });

    /** A bar chart that skips the bad month draws a store that was closed. */
    it('fills a month with no sales with zeros rather than a gap', async () => {
      const shirt = await createProduct('Camiseta Preta', ['Único']);
      await placeOrder([{ product: shirt }], {
        paidAt: '2026-07-10T12:00:00.000Z',
      });
      await placeOrder([{ product: shirt }], {
        paidAt: '2026-09-10T12:00:00.000Z',
      });

      const response = await get(
        `/reports/revenue?${QUARTER}&granularity=month`,
      ).expect(200);
      const report = response.body as RevenueReport;

      const august = report.buckets.find((b) => b.periodStart === '2026-08-01');

      expect(august).toBeDefined();
      expect(august?.revenueCents).toBe(0);
      expect(august?.orderCount).toBe(0);

      // Ascending, and no month missing between the two that sold.
      const starts = report.buckets.map((b) => b.periodStart);
      expect(starts).toEqual([...starts].sort());
      expect(starts).toContain('2026-07-01');
      expect(starts).toContain('2026-09-01');
    });

    it('cuts weeks on a Monday', async () => {
      const response = await get(
        `/reports/revenue?${AUGUST}&granularity=week`,
      ).expect(200);
      const report = response.body as RevenueReport;

      expect(report.buckets.length).toBeGreaterThan(1);

      for (const bucket of report.buckets) {
        // Parsed as UTC midnight, which is what a bare date means to Date.
        expect(new Date(`${bucket.periodStart}T00:00:00Z`).getUTCDay()).toBe(1);
      }
    });

    /**
     * Invariant 4, and the only test that can catch getting it backwards.
     *
     * 01:30 UTC on 1 September is 22:30 on 31 August in São Paulo. Bucketed in
     * UTC this sale is September's; bucketed in the store's zone — which is
     * whose month the shopkeeper is asking about — it is August's.
     *
     * Getting the double `AT TIME ZONE` wrong moves it three hours the OTHER
     * way, which lands it further into September and fails here.
     */
    it("buckets a late-night sale into the store's month, not UTC's", async () => {
      const shirt = await createProduct('Camiseta Preta', ['Único']);
      await placeOrder([{ product: shirt }], {
        paidAt: '2026-09-01T01:30:00.000Z',
      });

      const response = await get(
        `/reports/revenue?${QUARTER}&granularity=month`,
      ).expect(200);
      const report = response.body as RevenueReport;

      expect(report.timeZone).toBe(STORE_TIME_ZONE);

      const august = report.buckets.find((b) => b.periodStart === '2026-08-01');
      const september = report.buckets.find(
        (b) => b.periodStart === '2026-09-01',
      );

      expect(august?.orderCount).toBe(1);
      expect(september?.orderCount).toBe(0);
    });

    it('defaults to months', async () => {
      const response = await get(`/reports/revenue?${AUGUST}`).expect(200);

      expect((response.body as RevenueReport).granularity).toBe('month');
    });

    it('refuses a granularity outside the enum', async () => {
      await get(`/reports/revenue?${AUGUST}&granularity=day`).expect(400);
    });
  });

  describe('what is in carts right now', () => {
    async function addToCart(variantId: string, quantity: number) {
      await http()
        .post('/cart/items')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ variantId, quantity })
        .expect(201);
    }

    it('counts pieces, lines and the carts holding them', async () => {
      const shirt = await createProduct('Camiseta Preta', ['P', 'M']);

      await addToCart(shirt.variants[0].id, 3);
      await addToCart(shirt.variants[1].id, 1);

      const response = await get('/reports/carts').expect(200);

      expect(response.body as CartsReport).toEqual({
        unitCount: 4,
        lineCount: 2,
        cartCount: 1,
      });
    });

    it('reads an empty store as three zeros', async () => {
      const response = await get('/reports/carts').expect(200);

      expect(response.body as CartsReport).toEqual({
        unitCount: 0,
        lineCount: 0,
        cartCount: 0,
      });
    });

    /**
     * Checkout consumes the items and leaves the cart row alive and empty.
     * Counting rows in `carts` would therefore count everyone who ever bought
     * once — which is why the count comes from the LINES.
     */
    it('forgets a cart whose items were consumed by checkout', async () => {
      const shirt = await createProduct('Camiseta Preta', ['Único']);
      await addToCart(shirt.variants[0].id, 2);

      await expect(
        get('/reports/carts')
          .expect(200)
          .then((r) => (r.body as CartsReport).cartCount),
      ).resolves.toBe(1);

      await prisma.cartItem.deleteMany({});

      const response = await get('/reports/carts').expect(200);

      expect((response.body as CartsReport).cartCount).toBe(0);
      await expect(prisma.cart.count()).resolves.toBe(1);
    });
  });

  describe('what is not moving', () => {
    it('lists an ACTIVE piece with stock and no sale in the window', async () => {
      const shirt = await createProduct('Camiseta Preta', ['Único']);

      const response = await get(`/reports/unsold-products?${AUGUST}`).expect(
        200,
      );
      const report = response.body as UnsoldProductsReport;

      expect(report.items).toHaveLength(1);
      expect(report.items[0].productId).toBe(shirt.id);
      expect(report.items[0].stockQuantity).toBe(10);
      expect(report.items[0].lastSoldAt).toBeNull();
      expect(report.total).toBe(1);
    });

    /** The exact complement of product-sales, by construction. */
    it('drops a piece the moment it sells in the window', async () => {
      const shirt = await createProduct('Camiseta Preta', ['Único']);
      await placeOrder([{ product: shirt }]);

      const response = await get(`/reports/unsold-products?${AUGUST}`).expect(
        200,
      );

      expect((response.body as UnsoldProductsReport).items).toEqual([]);
    });

    it('still lists a piece whose only sale predates the window, and dates it', async () => {
      const shirt = await createProduct('Camiseta Preta', ['Único']);
      await placeOrder([{ product: shirt }], {
        paidAt: '2026-05-04T18:30:00.000Z',
      });

      const response = await get(`/reports/unsold-products?${AUGUST}`).expect(
        200,
      );
      const report = response.body as UnsoldProductsReport;

      expect(report.items).toHaveLength(1);
      expect(report.items[0].lastSoldAt).toBe('2026-05-04T18:30:00.000Z');
    });

    /** Sold out is not "not moving" — it is the opposite of it. */
    it('leaves out a piece with no stock at all', async () => {
      const shirt = await createProduct('Camiseta Preta', ['Único'], 7990, 0);

      expect(shirt.variants[0].stockQuantity).toBe(0);

      const response = await get(`/reports/unsold-products?${AUGUST}`).expect(
        200,
      );

      expect((response.body as UnsoldProductsReport).items).toEqual([]);
    });

    it.each([ProductStatus.DRAFT, ProductStatus.ARCHIVED])(
      'leaves out a %s piece, which is not for sale to begin with',
      async (status) => {
        const shirt = await createProduct('Camiseta Preta', ['Único']);

        await http()
          .patch(`/products/${shirt.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ status })
          .expect(200);

        const response = await get(`/reports/unsold-products?${AUGUST}`).expect(
          200,
        );

        expect((response.body as UnsoldProductsReport).items).toEqual([]);
      },
    );

    it('sums stock across sizes and puts the most idle capital first', async () => {
      await createProduct('Camiseta Preta', ['P', 'M'], 7990, 4);
      const trousers = await createProduct('Calça Cargo', ['Único'], 15990, 20);

      const response = await get(`/reports/unsold-products?${AUGUST}`).expect(
        200,
      );
      const report = response.body as UnsoldProductsReport;

      expect(report.items.map((item) => item.name)).toEqual([
        'Calça Cargo',
        'Camiseta Preta',
      ]);
      expect(report.items[0].productId).toBe(trousers.id);
      expect(report.items[0].stockQuantity).toBe(20);
      // Two sizes of four each.
      expect(report.items[1].stockQuantity).toBe(8);
    });
  });

  /**
   * The constraint the whole spec opens with. A report that moved anything
   * would be a back office that changes the shop by looking at it.
   */
  it('changes nothing it reads', async () => {
    const shirt = await createProduct('Camiseta Preta', ['P', 'M']);
    const orderId = await placeOrder([{ product: shirt, quantity: 2 }]);

    await http()
      .post('/cart/items')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId: shirt.variants[0].id, quantity: 1 })
      .expect(201);

    const before = {
      order: await prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
      variants: await prisma.productVariant.findMany({
        orderBy: { id: 'asc' },
      }),
      cartItems: await prisma.cartItem.findMany({ orderBy: { id: 'asc' } }),
      products: await prisma.product.findMany({ orderBy: { id: 'asc' } }),
    };

    for (const route of ROUTES) {
      await get(`${route}?${AUGUST}`).expect(200);
    }

    expect(
      await prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
    ).toEqual(before.order);
    expect(
      await prisma.productVariant.findMany({ orderBy: { id: 'asc' } }),
    ).toEqual(before.variants);
    expect(await prisma.cartItem.findMany({ orderBy: { id: 'asc' } })).toEqual(
      before.cartItems,
    );
    expect(await prisma.product.findMany({ orderBy: { id: 'asc' } })).toEqual(
      before.products,
    );
  });
});
