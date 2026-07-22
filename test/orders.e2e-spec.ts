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

const ADDRESS = {
  line1: 'Rua das Flores, 123',
  city: 'Curitiba',
  state: 'PR',
  postalCode: '80000-000',
};

interface CartResponse {
  items: {
    productId: string;
    quantity: number;
    product: {
      id: string;
      name: string;
      priceCents: number;
      status: ProductStatus;
      stockQuantity: number;
    };
  }[];
}

interface OrderResponse {
  id: string;
  userId: string;
  status: OrderStatus;
  totalCents: number;
  paymentRef: string | null;
  paidAt: string | null;
  cancelledAt: string | null;
  items: {
    productId: string;
    productName: string;
    unitPriceCents: number;
    quantity: number;
  }[];
}

/**
 * Covers the acceptance criteria of docs/specs/orders.md at the HTTP level,
 * against the real database. The concurrency criteria (double checkout, the
 * stock race) go through real HTTP into real transactions — they are claims
 * about row locks, and only Postgres can falsify those. The RLS criterion is
 * verified via the Supabase security advisor after the migration deploy, the
 * same posture check the catalog module used.
 */
describe('Orders (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let resetRateLimits: () => void;

  let adminToken: string;
  let operatorToken: string;
  let customerToken: string;
  let customerBToken: string;

  beforeAll(async () => {
    ({ app, prisma, resetRateLimits } = await createTestApp());
    const passwords = app.get(PasswordService);
    const passwordHash = await passwords.hash(PASSWORD);

    await resetOrdersTables(prisma);
    await resetAuthTables(prisma);
    await resetCatalogTables(prisma);

    for (const roleName of ['admin', 'operator', 'customer']) {
      await createUserWithRole(prisma, {
        email: `orders-${roleName}@example.com`,
        passwordHash,
        roleName,
      });
    }
    // A second customer, to prove carts and orders never leak across owners.
    await createUserWithRole(prisma, {
      email: 'orders-customer-b@example.com',
      passwordHash,
      roleName: 'customer',
    });

    adminToken = await login('orders-admin@example.com');
    operatorToken = await login('orders-operator@example.com');
    customerToken = await login('orders-customer@example.com');
    customerBToken = await login('orders-customer-b@example.com');
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
        name: 'Camiseta Azul',
        priceCents: 4990,
        status: ProductStatus.ACTIVE,
        stockQuantity: 10,
        ...overrides,
      })
      .expect(201);

    return response.body as { id: string };
  }

  async function addToCart(
    token: string,
    productId: string,
    quantity: number,
  ): Promise<CartResponse> {
    const response = await http()
      .post('/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId, quantity })
      .expect(201);

    return response.body as CartResponse;
  }

  function checkout(token: string) {
    return http()
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ shippingAddress: ADDRESS });
  }

  async function checkedOutOrder(token: string): Promise<OrderResponse> {
    const response = await checkout(token).expect(201);
    return response.body as OrderResponse;
  }

  async function stockOf(productId: string): Promise<number> {
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: productId },
      select: { stockQuantity: true },
    });
    return product.stockQuantity;
  }

  async function transition(
    orderId: string,
    verb: string,
    token: string,
    expected = 200,
  ): Promise<OrderResponse> {
    const response = await http()
      .post(`/orders/${orderId}/${verb}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(expected);

    return response.body as OrderResponse;
  }

  describe('cart', () => {
    it('requires authentication on every route', async () => {
      await http().get('/cart').expect(401);
      await http()
        .post('/cart/items')
        .send({ productId: 'x', quantity: 1 })
        .expect(401);
    });

    it('lazily creates the cart on first add and shows live catalog data', async () => {
      const product = await createProduct();

      const cart = await addToCart(customerToken, product.id, 2);

      expect(cart.items).toHaveLength(1);
      expect(cart.items[0].quantity).toBe(2);
      expect(cart.items[0].product.priceCents).toBe(4990);
      expect(cart.items[0].product.stockQuantity).toBe(10);
    });

    it('sums quantities when the same product is added again', async () => {
      const product = await createProduct();

      await addToCart(customerToken, product.id, 2);
      const cart = await addToCart(customerToken, product.id, 3);

      expect(cart.items).toHaveLength(1);
      expect(cart.items[0].quantity).toBe(5);
    });

    it('404s adding a hidden or missing product — indistinguishably', async () => {
      const draft = await createProduct({ status: ProductStatus.DRAFT });

      await http()
        .post('/cart/items')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ productId: draft.id, quantity: 1 })
        .expect(404);

      await http()
        .post('/cart/items')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          productId: '00000000-0000-4000-8000-000000000000',
          quantity: 1,
        })
        .expect(404);
    });

    it('400s non-positive, fractional or oversized quantities', async () => {
      const product = await createProduct();

      for (const quantity of [0, -1, 1.5, 1000]) {
        await http()
          .post('/cart/items')
          .set('Authorization', `Bearer ${customerToken}`)
          .send({ productId: product.id, quantity })
          .expect(400);
      }
    });

    it('sets absolute quantities, removes items, clears the cart', async () => {
      const product = await createProduct();
      await addToCart(customerToken, product.id, 2);

      const afterSet = await http()
        .patch(`/cart/items/${product.id}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ quantity: 5 })
        .expect(200);
      expect((afterSet.body as CartResponse).items[0].quantity).toBe(5);

      const afterRemove = await http()
        .delete(`/cart/items/${product.id}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
      expect((afterRemove.body as CartResponse).items).toHaveLength(0);

      await addToCart(customerToken, product.id, 1);
      const afterClear = await http()
        .delete('/cart')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
      expect((afterClear.body as CartResponse).items).toHaveLength(0);
    });

    it('never shows one user the cart of another', async () => {
      const product = await createProduct();
      await addToCart(customerToken, product.id, 2);

      const other = await http()
        .get('/cart')
        .set('Authorization', `Bearer ${customerBToken}`)
        .expect(200);
      expect((other.body as CartResponse).items).toHaveLength(0);

      // B adjusting A's item is a plain miss — B's cart has no such item.
      await http()
        .patch(`/cart/items/${product.id}`)
        .set('Authorization', `Bearer ${customerBToken}`)
        .send({ quantity: 9 })
        .expect(404);
    });

    it('shows the live price after a catalog change — the cart locks nothing', async () => {
      const product = await createProduct();
      await addToCart(customerToken, product.id, 1);

      await http()
        .patch(`/products/${product.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ priceCents: 6990 })
        .expect(200);

      const cart = await http()
        .get('/cart')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
      expect((cart.body as CartResponse).items[0].product.priceCents).toBe(
        6990,
      );
    });
  });

  describe('checkout', () => {
    it('freezes the cart into a CREATED order: snapshot, total, stock, payment ref', async () => {
      const shirt = await createProduct({ name: 'Camiseta', priceCents: 1000 });
      const mug = await createProduct({ name: 'Caneca', priceCents: 2500 });
      await addToCart(customerToken, shirt.id, 2);
      await addToCart(customerToken, mug.id, 1);

      const order = await checkedOutOrder(customerToken);

      expect(order.status).toBe(OrderStatus.CREATED);
      expect(order.totalCents).toBe(4500);
      // A checkout session opened by the provider; what it does after that is
      // test/payments.e2e-spec.ts's business.
      expect(order.paymentRef).toMatch(/^cs_test_/);
      expect(order.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            productId: shirt.id,
            productName: 'Camiseta',
            unitPriceCents: 1000,
            quantity: 2,
          }),
          expect.objectContaining({
            productId: mug.id,
            productName: 'Caneca',
            unitPriceCents: 2500,
            quantity: 1,
          }),
        ]),
      );

      await expect(stockOf(shirt.id)).resolves.toBe(8);
      await expect(stockOf(mug.id)).resolves.toBe(9);

      const cart = await http()
        .get('/cart')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
      expect((cart.body as CartResponse).items).toHaveLength(0);
    });

    it('keeps the purchase-time price after the catalog moves on', async () => {
      const product = await createProduct({ priceCents: 4990 });
      await addToCart(customerToken, product.id, 1);
      const order = await checkedOutOrder(customerToken);

      await http()
        .patch(`/products/${product.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ priceCents: 9990 })
        .expect(200);

      const fetched = await http()
        .get(`/orders/${order.id}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
      const body = fetched.body as OrderResponse;
      expect(body.items[0].unitPriceCents).toBe(4990);
      expect(body.totalCents).toBe(4990);
    });

    it('409s naming the item when stock is insufficient, changing nothing', async () => {
      const scarce = await createProduct({ name: 'Raro', stockQuantity: 1 });
      const plenty = await createProduct({ name: 'Comum', stockQuantity: 10 });
      await addToCart(customerToken, scarce.id, 2);
      await addToCart(customerToken, plenty.id, 1);

      const response = await checkout(customerToken).expect(409);

      expect((response.body as { productIds: string[] }).productIds).toEqual([
        scarce.id,
      ]);
      // Rolled back in one piece: no stock moved — not even the winnable
      // item's — and the cart survived intact.
      await expect(stockOf(scarce.id)).resolves.toBe(1);
      await expect(stockOf(plenty.id)).resolves.toBe(10);
      const cart = await http()
        .get('/cart')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
      expect((cart.body as CartResponse).items).toHaveLength(2);
      await expect(prisma.order.count()).resolves.toBe(0);
    });

    it('409s when a cart item was archived after being added', async () => {
      const product = await createProduct();
      await addToCart(customerToken, product.id, 1);

      await http()
        .delete(`/products/${product.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const response = await checkout(customerToken).expect(409);
      expect((response.body as { productIds: string[] }).productIds).toEqual([
        product.id,
      ]);
    });

    it('409s an empty cart and 400s a checkout without an address', async () => {
      await checkout(customerToken).expect(409);

      await http()
        .post('/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({})
        .expect(400);
    });

    it('produces exactly one order from two concurrent checkouts of the same cart', async () => {
      const product = await createProduct();
      await addToCart(customerToken, product.id, 1);

      const [first, second] = await Promise.all([
        checkout(customerToken),
        checkout(customerToken),
      ]);

      // The cart is consumed inside the transaction with a counted delete —
      // the loser's delete matches zero rows and aborts. Which request wins
      // depends on scheduling; that exactly one wins does not.
      expect([first.status, second.status].sort()).toEqual([201, 409]);
      await expect(prisma.order.count()).resolves.toBe(1);
      await expect(stockOf(product.id)).resolves.toBe(9);
    });
  });

  describe('lifecycle', () => {
    async function createOrder(token = customerToken): Promise<OrderResponse> {
      const product = await createProduct({
        name: `Produto ${String(Math.random()).slice(2, 8)}`,
      });
      await addToCart(token, product.id, 2);
      return checkedOutOrder(token);
    }

    it('walks CREATED → PAID → SHIPPED → DELIVERED, stamping each step', async () => {
      const order = await createOrder();

      const paid = await transition(order.id, 'mark-paid', operatorToken);
      expect(paid.status).toBe(OrderStatus.PAID);
      expect(paid.paidAt).not.toBeNull();

      const shipped = await transition(order.id, 'ship', operatorToken);
      expect(shipped.status).toBe(OrderStatus.SHIPPED);

      const delivered = await transition(order.id, 'deliver', operatorToken);
      expect(delivered.status).toBe(OrderStatus.DELIVERED);
    });

    it('403s a customer on the back-office transitions — even for their own order', async () => {
      const order = await createOrder();

      await transition(order.id, 'mark-paid', customerToken, 403);
    });

    it('409s transitions from the wrong state', async () => {
      const order = await createOrder();

      // Not paid yet: cannot ship, cannot deliver.
      await transition(order.id, 'ship', operatorToken, 409);
      await transition(order.id, 'deliver', operatorToken, 409);

      await transition(order.id, 'mark-paid', operatorToken);
      // Paying twice is a conflict at the domain level; the Stripe webhook
      // adapter will translate its retries on top of this later.
      await transition(order.id, 'mark-paid', operatorToken, 409);
    });

    it('lets a customer cancel their own CREATED order, restocking it', async () => {
      const product = await createProduct({ stockQuantity: 10 });
      await addToCart(customerToken, product.id, 2);
      const order = await checkedOutOrder(customerToken);
      await expect(stockOf(product.id)).resolves.toBe(8);

      const cancelled = await transition(order.id, 'cancel', customerToken);

      expect(cancelled.status).toBe(OrderStatus.CANCELLED);
      expect(cancelled.cancelledAt).not.toBeNull();
      await expect(stockOf(product.id)).resolves.toBe(10);
    });

    it('409s cancelling once the order is PAID — refunds do not exist yet', async () => {
      const order = await createOrder();
      await transition(order.id, 'mark-paid', operatorToken);

      await transition(order.id, 'cancel', customerToken, 409);
      // Not even orders.cancel reaches past CREATED.
      await transition(order.id, 'cancel', adminToken, 409);
    });

    it('routes foreign cancels by capability: admin may, operator 403s, stranger 404s', async () => {
      const order = await createOrder(customerToken);

      // Operator holds orders.read (sees the order) but not orders.cancel.
      await transition(order.id, 'cancel', operatorToken, 403);
      // Fellow customer cannot even see it.
      await transition(order.id, 'cancel', customerBToken, 404);

      const cancelled = await transition(order.id, 'cancel', adminToken);
      expect(cancelled.status).toBe(OrderStatus.CANCELLED);
    });
  });

  describe('ownership and listing', () => {
    it("404s a customer reading someone else's order; orders.read reads it", async () => {
      const product = await createProduct();
      await addToCart(customerToken, product.id, 1);
      const order = await checkedOutOrder(customerToken);

      await http()
        .get(`/orders/${order.id}`)
        .set('Authorization', `Bearer ${customerBToken}`)
        .expect(404);

      const asOperator = await http()
        .get(`/orders/${order.id}`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
      expect((asOperator.body as OrderResponse).id).toBe(order.id);
    });

    it('lists own orders for customers, everything (with filters) for orders.read', async () => {
      const product = await createProduct({ stockQuantity: 20 });
      await addToCart(customerToken, product.id, 1);
      await checkedOutOrder(customerToken);
      await addToCart(customerBToken, product.id, 1);
      const orderB = await checkedOutOrder(customerBToken);
      await transition(orderB.id, 'mark-paid', operatorToken);

      const own = await http()
        .get('/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
      const ownBody = own.body as { items: OrderResponse[]; total: number };
      expect(ownBody.total).toBe(1);
      expect(ownBody.items[0].userId).not.toBe(orderB.userId);

      const all = await http()
        .get('/orders')
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
      expect((all.body as { total: number }).total).toBe(2);

      const paidOnly = await http()
        .get('/orders')
        .query({ status: OrderStatus.PAID })
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
      const paidBody = paidOnly.body as { items: OrderResponse[] };
      expect(paidBody.items).toHaveLength(1);
      expect(paidBody.items[0].id).toBe(orderB.id);

      const byUser = await http()
        .get('/orders')
        .query({ userId: orderB.userId })
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
      expect((byUser.body as { total: number }).total).toBe(1);
    });

    it('403s a customer trying the privileged userId filter', async () => {
      await http()
        .get('/orders')
        .query({ userId: '00000000-0000-4000-8000-000000000000' })
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(403);
    });
  });
});
