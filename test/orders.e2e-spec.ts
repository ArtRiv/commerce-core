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

interface ProductVariant {
  id: string;
  label: string;
  position: number;
  stockQuantity: number;
}

interface ProductResponse {
  id: string;
  stockQuantity: number;
  variants: ProductVariant[];
}

interface CartResponse {
  items: {
    variantId: string;
    quantity: number;
    product: {
      id: string;
      name: string;
      priceCents: number;
      status: ProductStatus;
    };
    variant: ProductVariant;
  }[];
  itemsSubtotalCents: number;
  itemCount: number;
}

interface ShippingOptionResponse {
  code: string;
  label: string;
  priceCents: number;
  estimatedDays: number | null;
  orderTotalCents: number;
}

interface OrderResponse {
  id: string;
  userId: string;
  status: OrderStatus;
  itemsSubtotalCents: number;
  shippingCents: number;
  totalCents: number;
  shippingMethodCode: string | null;
  trackingCode: string | null;
  paymentRef: string | null;
  paidAt: string | null;
  cancelledAt: string | null;
  items: {
    productId: string;
    productName: string;
    variantId: string;
    variantLabel: string;
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

  /**
   * A product with ONE size unless told otherwise. Stock is a property of the
   * variant now, so `stockQuantity` here fills the single variant rather than
   * a column on the product.
   */
  async function createProduct(
    overrides: Record<string, unknown> = {},
  ): Promise<ProductResponse> {
    const { stockQuantity = 10, ...rest } = overrides;

    const response = await http()
      .post('/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Camiseta Azul',
        priceCents: 4990,
        status: ProductStatus.ACTIVE,
        variants: [{ label: 'Único', stockQuantity }],
        ...rest,
      })
      .expect(201);

    return response.body as ProductResponse;
  }

  /** The only variant of a single-size product — what most tests want. */
  function onlyVariant(product: ProductResponse): string {
    return product.variants[0].id;
  }

  async function addToCart(
    token: string,
    variantId: string,
    quantity: number,
  ): Promise<CartResponse> {
    const response = await http()
      .post('/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ variantId, quantity })
      .expect(201);

    return response.body as CartResponse;
  }

  /**
   * The freight the store would quote for this cart right now — what a real
   * storefront shows the customer before they confirm.
   */
  async function firstOption(token: string): Promise<ShippingOptionResponse> {
    const response = await http()
      .post('/shipping/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({ postalCode: ADDRESS.postalCode })
      .expect(200);

    const { options } = response.body as { options: ShippingOptionResponse[] };

    return options[0];
  }

  /**
   * Checkout takes the option's CODE plus the price it was quoted at; the
   * server re-quotes and compares. Kept chainable so the concurrency case can
   * still fire two requests at once.
   */
  function checkout(token: string, shipping: ShippingOptionResponse) {
    return http().post('/orders').set('Authorization', `Bearer ${token}`).send({
      shippingAddress: ADDRESS,
      shippingOptionCode: shipping.code,
      quotedShippingCents: shipping.priceCents,
    });
  }

  /** Quotes and then checks out, the way a storefront does. */
  async function checkedOutOrder(token: string): Promise<OrderResponse> {
    const response = await checkout(token, await firstOption(token)).expect(
      201,
    );

    return response.body as OrderResponse;
  }

  /**
   * For the cases that never reach the freight rules — an empty cart is
   * refused before anything is quoted — so the values here are only shape.
   */
  const UNUSED_OPTION: ShippingOptionResponse = {
    code: 'padrao-brasil',
    label: 'Entrega padrão',
    priceCents: 0,
    estimatedDays: null,
    orderTotalCents: 0,
  };

  /** Stock of one size, read straight from the table that now holds it. */
  async function stockOf(variantId: string): Promise<number> {
    const variant = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variantId },
      select: { stockQuantity: true },
    });
    return variant.stockQuantity;
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
        .send({ variantId: 'x', quantity: 1 })
        .expect(401);
    });

    it('lazily creates the cart on first add and shows live catalog data', async () => {
      const product = await createProduct();

      const cart = await addToCart(customerToken, onlyVariant(product), 2);

      expect(cart.items).toHaveLength(1);
      expect(cart.items[0].quantity).toBe(2);
      expect(cart.items[0].product.priceCents).toBe(4990);
      // The stock that travels is the SIZE's — the only one that means
      // anything on a cart line (docs/specs/product-variants.md).
      expect(cart.items[0].variant.stockQuantity).toBe(10);
    });

    it('sums quantities when the same product is added again', async () => {
      const product = await createProduct();

      await addToCart(customerToken, onlyVariant(product), 2);
      const cart = await addToCart(customerToken, onlyVariant(product), 3);

      expect(cart.items).toHaveLength(1);
      expect(cart.items[0].quantity).toBe(5);
    });

    it('404s adding a hidden or missing product — indistinguishably', async () => {
      const draft = await createProduct({ status: ProductStatus.DRAFT });

      await http()
        .post('/cart/items')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ variantId: onlyVariant(draft), quantity: 1 })
        .expect(404);

      await http()
        .post('/cart/items')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          variantId: '00000000-0000-4000-8000-000000000000',
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
          .send({ variantId: onlyVariant(product), quantity })
          .expect(400);
      }
    });

    it('sets absolute quantities, removes items, clears the cart', async () => {
      const product = await createProduct();
      await addToCart(customerToken, onlyVariant(product), 2);

      const afterSet = await http()
        .patch(`/cart/items/${onlyVariant(product)}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ quantity: 5 })
        .expect(200);
      expect((afterSet.body as CartResponse).items[0].quantity).toBe(5);

      const afterRemove = await http()
        .delete(`/cart/items/${onlyVariant(product)}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
      expect((afterRemove.body as CartResponse).items).toHaveLength(0);

      await addToCart(customerToken, onlyVariant(product), 1);
      const afterClear = await http()
        .delete('/cart')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
      expect((afterClear.body as CartResponse).items).toHaveLength(0);
    });

    it('never shows one user the cart of another', async () => {
      const product = await createProduct();
      await addToCart(customerToken, onlyVariant(product), 2);

      const other = await http()
        .get('/cart')
        .set('Authorization', `Bearer ${customerBToken}`)
        .expect(200);
      expect((other.body as CartResponse).items).toHaveLength(0);

      // B adjusting A's item is a plain miss — B's cart has no such item.
      await http()
        .patch(`/cart/items/${onlyVariant(product)}`)
        .set('Authorization', `Bearer ${customerBToken}`)
        .send({ quantity: 9 })
        .expect(404);
    });

    it('shows the live price after a catalog change — the cart locks nothing', async () => {
      const product = await createProduct();
      await addToCart(customerToken, onlyVariant(product), 1);

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

    it('totals the cart server-side, in pieces and in cents', async () => {
      const shirt = await createProduct();
      const trousers = await createProduct({
        name: 'Calça Preta',
        priceCents: 2500,
      });

      await addToCart(customerToken, onlyVariant(shirt), 2);
      await addToCart(customerToken, onlyVariant(trousers), 1);

      const cart = await http()
        .get('/cart')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);

      const body = cart.body as CartResponse;
      expect(body.itemsSubtotalCents).toBe(4990 * 2 + 2500);
      // Pieces, not lines: three garments across two lines is 3.
      expect(body.itemCount).toBe(3);
    });

    it('answers zero, not null, for a cart that never existed', async () => {
      const cart = await http()
        .get('/cart')
        .set('Authorization', `Bearer ${customerBToken}`)
        .expect(200);

      const body = cart.body as CartResponse;
      expect(body.items).toHaveLength(0);
      expect(body.itemsSubtotalCents).toBe(0);
      expect(body.itemCount).toBe(0);
    });

    it('carries the totals on every write, and zeroes them on clear', async () => {
      const product = await createProduct();

      const added = await addToCart(customerToken, onlyVariant(product), 2);
      expect(added.itemsSubtotalCents).toBe(9980);
      expect(added.itemCount).toBe(2);

      const afterSet = await http()
        .patch(`/cart/items/${onlyVariant(product)}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ quantity: 5 })
        .expect(200);
      expect((afterSet.body as CartResponse).itemsSubtotalCents).toBe(24950);
      expect((afterSet.body as CartResponse).itemCount).toBe(5);

      const afterClear = await http()
        .delete('/cart')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
      expect((afterClear.body as CartResponse).itemsSubtotalCents).toBe(0);
      expect((afterClear.body as CartResponse).itemCount).toBe(0);
    });

    it('reprices the subtotal when the catalog moves under the cart', async () => {
      const product = await createProduct();
      await addToCart(customerToken, onlyVariant(product), 2);

      await http()
        .patch(`/products/${product.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ priceCents: 6990 })
        .expect(200);

      const cart = await http()
        .get('/cart')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);

      // The subtotal follows the live price, because that is the price
      // checkout is about to freeze and charge.
      expect((cart.body as CartResponse).itemsSubtotalCents).toBe(13980);
    });
  });

  describe('checkout', () => {
    it('freezes the cart into a CREATED order: snapshot, total, stock, payment ref', async () => {
      const shirt = await createProduct({ name: 'Camiseta', priceCents: 1000 });
      const mug = await createProduct({ name: 'Caneca', priceCents: 2500 });
      await addToCart(customerToken, onlyVariant(shirt), 2);
      await addToCart(customerToken, onlyVariant(mug), 1);

      const order = await checkedOutOrder(customerToken);

      expect(order.status).toBe(OrderStatus.CREATED);
      // The items' own arithmetic, unchanged by freight...
      expect(order.itemsSubtotalCents).toBe(4500);
      // ...and the amount actually charged, which is that plus the freight
      // this cart was quoted. The exact figure belongs to the freight table,
      // so the identity is what matters here (shipping.e2e-spec.ts pins the
      // numbers).
      expect(order.totalCents).toBe(
        order.itemsSubtotalCents + order.shippingCents,
      );
      expect(order.shippingCents).toBeGreaterThan(0);
      expect(order.shippingMethodCode).not.toBeNull();
      // A checkout session opened by the provider; what it does after that is
      // test/payments.e2e-spec.ts's business.
      expect(order.paymentRef).toMatch(/^cs_test_/);
      expect(order.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            productId: shirt.id,
            variantId: onlyVariant(shirt),
            productName: 'Camiseta',
            variantLabel: 'Único',
            unitPriceCents: 1000,
            quantity: 2,
          }),
          expect.objectContaining({
            productId: mug.id,
            variantId: onlyVariant(mug),
            productName: 'Caneca',
            variantLabel: 'Único',
            unitPriceCents: 2500,
            quantity: 1,
          }),
        ]),
      );

      await expect(stockOf(onlyVariant(shirt))).resolves.toBe(8);
      await expect(stockOf(onlyVariant(mug))).resolves.toBe(9);

      const cart = await http()
        .get('/cart')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
      expect((cart.body as CartResponse).items).toHaveLength(0);
    });

    it('keeps the purchase-time price after the catalog moves on', async () => {
      const product = await createProduct({ priceCents: 4990 });
      await addToCart(customerToken, onlyVariant(product), 1);
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
      expect(body.itemsSubtotalCents).toBe(4990);
      expect(body.totalCents).toBe(
        body.itemsSubtotalCents + body.shippingCents,
      );
    });

    it('409s naming the item when stock is insufficient, changing nothing', async () => {
      const scarce = await createProduct({ name: 'Raro', stockQuantity: 1 });
      const plenty = await createProduct({ name: 'Comum', stockQuantity: 10 });
      await addToCart(customerToken, onlyVariant(scarce), 2);
      await addToCart(customerToken, onlyVariant(plenty), 1);

      const response = await checkout(
        customerToken,
        await firstOption(customerToken),
      ).expect(409);

      // The PIECE, not just an id: a storefront cannot strike anything
      // through without knowing which size lost.
      expect(
        (response.body as { unavailableItems: unknown[] }).unavailableItems,
      ).toEqual([
        {
          variantId: onlyVariant(scarce),
          productId: scarce.id,
          productName: 'Raro',
          variantLabel: 'Único',
        },
      ]);
      // Rolled back in one piece: no stock moved — not even the winnable
      // item's — and the cart survived intact.
      await expect(stockOf(onlyVariant(scarce))).resolves.toBe(1);
      await expect(stockOf(onlyVariant(plenty))).resolves.toBe(10);
      const cart = await http()
        .get('/cart')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
      expect((cart.body as CartResponse).items).toHaveLength(2);
      await expect(prisma.order.count()).resolves.toBe(0);
    });

    it('409s when a cart item was archived after being added', async () => {
      const product = await createProduct();
      await addToCart(customerToken, onlyVariant(product), 1);

      await http()
        .delete(`/products/${product.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // Quoted while the product was still sellable, which is exactly the
      // race this 409 is about.
      const response = await checkout(customerToken, UNUSED_OPTION).expect(409);
      expect(
        (response.body as { unavailableItems: { productId: string }[] })
          .unavailableItems,
      ).toEqual([expect.objectContaining({ productId: product.id })]);
    });

    it('409s an empty cart and 400s a checkout without an address', async () => {
      // The empty cart is refused before freight is ever quoted, so the
      // shipping fields here are never read.
      await checkout(customerToken, UNUSED_OPTION).expect(409);

      await http()
        .post('/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({})
        .expect(400);
    });

    it('produces exactly one order from two concurrent checkouts of the same cart', async () => {
      const product = await createProduct();
      await addToCart(customerToken, onlyVariant(product), 1);

      const option = await firstOption(customerToken);
      const [first, second] = await Promise.all([
        checkout(customerToken, option),
        checkout(customerToken, option),
      ]);

      // The cart is consumed inside the transaction with a counted delete —
      // the loser's delete matches zero rows and aborts. Which request wins
      // depends on scheduling; that exactly one wins does not.
      expect([first.status, second.status].sort()).toEqual([201, 409]);
      await expect(prisma.order.count()).resolves.toBe(1);
      await expect(stockOf(onlyVariant(product))).resolves.toBe(9);
    });
  });

  /**
   * Covers docs/specs/product-variants.md where it crosses the cart and the
   * order: the size is the sellable unit, and the two claims that only a real
   * database can settle — the right variant loses stock, and two buyers racing
   * for the last M produce exactly one order.
   */
  describe('variants', () => {
    /** A shirt in five sizes, in the order a size selector renders them. */
    async function shirtInSizes(
      stock: Record<string, number> = { P: 2, M: 2, G: 2, GG: 2, XGG: 2 },
    ): Promise<ProductResponse> {
      return createProduct({
        name: 'Camiseta Preta',
        variants: ['P', 'M', 'G', 'GG', 'XGG'].map((label) => ({
          label,
          stockQuantity: stock[label] ?? 0,
        })),
      });
    }

    function sizeOf(product: ProductResponse, label: string): string {
      const variant = product.variants.find((v) => v.label === label);
      if (!variant) {
        throw new Error(`This fixture has no ${label}`);
      }
      return variant.id;
    }

    it('orders sizes by position, not alphabetically, and keeps sold-out ones', async () => {
      const shirt = await shirtInSizes({ P: 2, M: 0, G: 2, GG: 2, XGG: 2 });

      const response = await http().get(`/products/${shirt.id}`).expect(200);
      const body = response.body as ProductResponse;

      // Alphabetically this would be G, GG, M, P, XGG — which is why the
      // column exists.
      expect(body.variants.map((variant) => variant.label)).toEqual([
        'P',
        'M',
        'G',
        'GG',
        'XGG',
      ]);
      // The sold-out M is present with zero, not missing: struck through in
      // the storefront, never hidden.
      expect(body.variants[1]).toMatchObject({ label: 'M', stockQuantity: 0 });
      // The product's own number is the sum, for the grid's "Esgotado".
      expect(body.stockQuantity).toBe(8);
    });

    it('keeps two sizes of one shirt as two cart lines and two order lines', async () => {
      const shirt = await shirtInSizes();

      await addToCart(customerToken, sizeOf(shirt, 'P'), 1);
      const cart = await addToCart(customerToken, sizeOf(shirt, 'M'), 2);

      expect(cart.items).toHaveLength(2);
      // Compared as a SET: cart lines come back ordered by cart_items.id, a
      // random UUID, so the order between two lines is stable per cart but
      // meaningless. Recorded in docs/known-issues.md; a storefront that
      // wants P before M sorts on variant.position itself.
      expect(cart.items.map((item) => item.variant.label).sort()).toEqual([
        'M',
        'P',
      ]);
      expect(cart.itemCount).toBe(3);

      const order = await checkedOutOrder(customerToken);

      expect(order.items).toHaveLength(2);
      expect(order.items.map((item) => item.variantLabel).sort()).toEqual([
        'M',
        'P',
      ]);
      // The label is frozen beside the name and the price.
      expect(
        order.items.every((item) => item.productName === 'Camiseta Preta'),
      ).toBe(true);
    });

    it('decrements the size that was bought and leaves its siblings alone', async () => {
      const shirt = await shirtInSizes({ P: 5, M: 5, G: 5, GG: 5, XGG: 5 });
      await addToCart(customerToken, sizeOf(shirt, 'M'), 2);

      await checkedOutOrder(customerToken);

      await expect(stockOf(sizeOf(shirt, 'M'))).resolves.toBe(3);
      await expect(stockOf(sizeOf(shirt, 'P'))).resolves.toBe(5);
      await expect(stockOf(sizeOf(shirt, 'G'))).resolves.toBe(5);
    });

    it('409s naming the size that ran out, not the product', async () => {
      const shirt = await shirtInSizes({ P: 10, M: 1, G: 10, GG: 10, XGG: 10 });
      await addToCart(customerToken, sizeOf(shirt, 'M'), 2);

      const response = await checkout(
        customerToken,
        await firstOption(customerToken),
      ).expect(409);

      expect(
        (response.body as { unavailableItems: unknown[] }).unavailableItems,
      ).toEqual([
        {
          variantId: sizeOf(shirt, 'M'),
          productId: shirt.id,
          productName: 'Camiseta Preta',
          variantLabel: 'M',
        },
      ]);
      // Nothing moved: not the M, and not the sizes that would have won.
      await expect(stockOf(sizeOf(shirt, 'M'))).resolves.toBe(1);
      await expect(prisma.order.count()).resolves.toBe(0);
    });

    it('produces exactly one order from two buyers racing for the last M', async () => {
      const shirt = await shirtInSizes({ P: 5, M: 1, G: 5, GG: 5, XGG: 5 });
      await addToCart(customerToken, sizeOf(shirt, 'M'), 1);
      await addToCart(customerBToken, sizeOf(shirt, 'M'), 1);

      const option = await firstOption(customerToken);
      const [first, second] = await Promise.all([
        checkout(customerToken, option),
        checkout(customerBToken, option),
      ]);

      // Two DIFFERENT carts this time, so the cart-consumption guard cannot
      // be what settles it: the winner is decided by the conditional UPDATE
      // on the variant's stock, inside Postgres.
      expect([first.status, second.status].sort()).toEqual([201, 409]);
      await expect(prisma.order.count()).resolves.toBe(1);
      await expect(stockOf(sizeOf(shirt, 'M'))).resolves.toBe(0);
    });

    it('restocks the right size when the order is cancelled', async () => {
      const shirt = await shirtInSizes({ P: 5, M: 5, G: 5, GG: 5, XGG: 5 });
      await addToCart(customerToken, sizeOf(shirt, 'GG'), 2);
      const order = await checkedOutOrder(customerToken);
      await expect(stockOf(sizeOf(shirt, 'GG'))).resolves.toBe(3);

      await transition(order.id, 'cancel', customerToken);

      await expect(stockOf(sizeOf(shirt, 'GG'))).resolves.toBe(5);
      await expect(stockOf(sizeOf(shirt, 'M'))).resolves.toBe(5);
    });

    it('gives a product created without variants exactly one, labelled Unico', async () => {
      const product = await createProduct({ variants: undefined });

      const response = await http().get(`/products/${product.id}`).expect(200);
      const body = response.body as ProductResponse;

      // Never zero: a product with no variant is unbuyable, and the fork
      // "product with / without variants" is what this rule prevents.
      expect(body.variants).toHaveLength(1);
      expect(body.variants[0]).toMatchObject({ label: 'Único', position: 0 });
    });

    it('sets stock on one size only, through the variant route', async () => {
      const shirt = await shirtInSizes({ P: 5, M: 5, G: 5, GG: 5, XGG: 5 });

      const response = await http()
        .patch(`/products/${shirt.id}/variants/${sizeOf(shirt, 'G')}/stock`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ quantity: 12 })
        .expect(200);

      const body = response.body as ProductResponse;
      expect(
        body.variants.find((variant) => variant.label === 'G')?.stockQuantity,
      ).toBe(12);
      expect(
        body.variants.find((variant) => variant.label === 'M')?.stockQuantity,
      ).toBe(5);
      // 5 + 5 + 12 + 5 + 5 — the product's number follows its sizes.
      expect(body.stockQuantity).toBe(32);
    });

    it('404s a variant addressed under a product that does not own it', async () => {
      const shirt = await shirtInSizes();
      const other = await createProduct({ name: 'Outra Peça' });

      await http()
        .patch(`/products/${other.id}/variants/${sizeOf(shirt, 'M')}/stock`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ quantity: 1 })
        .expect(404);
    });

    it('adds a size afterwards and refuses a duplicate label', async () => {
      const shirt = await shirtInSizes();

      const response = await http()
        .post(`/products/${shirt.id}/variants`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ label: 'XXG', stockQuantity: 3 })
        .expect(201);

      const body = response.body as ProductResponse;
      // Appended to the end, which is where a new size almost always goes.
      expect(body.variants.map((variant) => variant.label)).toEqual([
        'P',
        'M',
        'G',
        'GG',
        'XGG',
        'XXG',
      ]);

      await http()
        .post(`/products/${shirt.id}/variants`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ label: 'M' })
        .expect(409);
    });
  });

  describe('lifecycle', () => {
    async function createOrder(token = customerToken): Promise<OrderResponse> {
      const product = await createProduct({
        name: `Produto ${String(Math.random()).slice(2, 8)}`,
      });
      await addToCart(token, onlyVariant(product), 2);
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
      await addToCart(customerToken, onlyVariant(product), 2);
      const order = await checkedOutOrder(customerToken);
      await expect(stockOf(onlyVariant(product))).resolves.toBe(8);

      const cancelled = await transition(order.id, 'cancel', customerToken);

      expect(cancelled.status).toBe(OrderStatus.CANCELLED);
      expect(cancelled.cancelledAt).not.toBeNull();
      await expect(stockOf(onlyVariant(product))).resolves.toBe(10);
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
      await addToCart(customerToken, onlyVariant(product), 1);
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
      await addToCart(customerToken, onlyVariant(product), 1);
      await checkedOutOrder(customerToken);
      await addToCart(customerBToken, onlyVariant(product), 1);
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
