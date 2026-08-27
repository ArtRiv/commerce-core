import {
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { type Permission, PERMISSIONS } from '../auth/authz/permissions';
import type { ProductsService } from '../catalog/products.service';
import type { StockService } from '../catalog/stock.service';
import { OrderStatus, ProductStatus } from '../generated/prisma/enums';
import type {
  PaymentSession,
  SessionLookup,
} from '../payments/payment-provider';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  ShippingOption,
  ShippingQuoteRequest,
} from '../shipping/shipping-provider';
import type { CartService } from './cart.service';
import type { OrderNotificationsService } from './order-notifications.service';
import {
  type CheckoutInput,
  OrdersService,
  type ShippingAddress,
} from './orders.service';
import { ShippingQuoteService } from './shipping-quote.service';

const ADDRESS: ShippingAddress = {
  line1: 'Rua das Flores, 123',
  city: 'Curitiba',
  state: 'PR',
  postalCode: '80000-000',
};

/** What the table provider offers for ADDRESS in these tests. */
const SHIPPING_OPTION: ShippingOption = {
  code: 'padrao-brasil',
  label: 'Entrega padrão',
  priceCents: 1990,
  estimatedDays: 10,
  carrier: null,
};

/** Matches SHIPPING_DEFAULT_WEIGHT_GRAMS' fallback in ShippingModule. */
const DEFAULT_WEIGHT_GRAMS = 500;

function checkoutInput(overrides: Partial<CheckoutInput> = {}): CheckoutInput {
  return {
    address: ADDRESS,
    shippingOptionCode: SHIPPING_OPTION.code,
    quotedShippingCents: SHIPPING_OPTION.priceCents,
    ...overrides,
  };
}

interface OrderRow {
  id: string;
  userId: string;
  status: OrderStatus;
  itemsSubtotalCents: number;
  shippingCents: number;
  totalCents: number;
  paymentRef: string | null;
  paymentIntentRef: string | null;
  items: {
    productId: string;
    productName: string;
    variantId: string;
    variantLabel: string;
    unitPriceCents: number;
    quantity: number;
  }[];
}

function orderRow(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: 'order-1',
    userId: 'user-1',
    status: OrderStatus.CREATED,
    // 2 × 1000 + 1 × 2500 of items, plus SHIPPING_OPTION's freight. totalCents
    // is the sum — the row a database holding the CHECK constraint would give
    // back — which is what makes the createPayment assertions below a real
    // proof that freight reaches the card.
    itemsSubtotalCents: 4500,
    shippingCents: 1990,
    totalCents: 6490,
    paymentRef: null,
    paymentIntentRef: null,
    items: [],
    ...overrides,
  };
}

const EXPIRES_AT = new Date('2026-07-22T00:00:00.000Z');

function paymentSession(
  overrides: Partial<PaymentSession> = {},
): PaymentSession {
  return {
    providerRef: 'cs_1',
    mode: 'hosted',
    url: 'https://pay.example/cs_1',
    clientSecret: null,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function createPrismaMock() {
  const base = {
    cart: {
      findUnique: jest.fn<
        Promise<{
          id: string;
          items: { variantId: string; quantity: number }[];
        } | null>,
        [unknown]
      >(),
    },
    cartItem: {
      deleteMany: jest.fn<Promise<{ count: number }>, [unknown]>(),
    },
    order: {
      create: jest
        .fn<Promise<OrderRow>, [unknown]>()
        .mockResolvedValue(orderRow()),
      update: jest
        .fn<Promise<OrderRow>, [unknown]>()
        .mockResolvedValue(orderRow({ paymentRef: 'cs_1' })),
      // Claiming writes succeed by default; the tests that care about losing a
      // race set count: 0 explicitly.
      updateMany: jest
        .fn<Promise<{ count: number }>, [unknown]>()
        .mockResolvedValue({ count: 1 }),
      findFirst: jest.fn<Promise<OrderRow | null>, [unknown]>(),
      findUnique: jest
        .fn<Promise<OrderRow | null>, [unknown]>()
        .mockResolvedValue(orderRow()),
      findMany: jest.fn<Promise<OrderRow[]>, [unknown]>().mockResolvedValue([]),
      count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
    },
    orderItem: {
      findMany: jest
        .fn<Promise<{ variantId: string; quantity: number }[]>, [unknown]>()
        .mockResolvedValue([]),
    },
  };

  return {
    ...base,
    $transaction: jest.fn((fn: (tx: typeof base) => Promise<unknown>) =>
      fn(base),
    ),
  };
}

function createProductsMock() {
  return {
    findSellableByVariantIds: jest.fn<
      Promise<
        {
          id: string;
          label: string;
          position: number;
          stockQuantity: number;
          product: {
            id: string;
            name: string;
            slug: string;
            priceCents: number;
            status: ProductStatus;
            weightGrams: number | null;
          };
        }[]
      >,
      [string[]]
    >(),
  };
}

function createStockMock() {
  return {
    decrement: jest
      .fn<Promise<boolean>, [string, number, unknown]>()
      .mockResolvedValue(true),
    restock: jest
      .fn<Promise<void>, [string, number, unknown]>()
      .mockResolvedValue(undefined),
  };
}

function createPaymentsMock() {
  return {
    createPayment: jest
      .fn<Promise<PaymentSession>, [unknown]>()
      .mockResolvedValue(paymentSession()),
    // Nothing at the provider by default: the common case is an order that has
    // never been paid for.
    getPayment: jest
      .fn<Promise<SessionLookup>, [string]>()
      .mockResolvedValue({ state: 'gone' }),
    expirePayment: jest
      .fn<Promise<void>, [string]>()
      .mockResolvedValue(undefined),
    refund: jest
      .fn<Promise<{ refundRef: string }>, [unknown]>()
      .mockResolvedValue({ refundRef: 're_1' }),
    parseEvent: jest.fn(),
  };
}

/**
 * Only the PROVIDER is doubled — the module boundary — while the real
 * ShippingQuoteService runs. Its price assertion and its 503 translation are
 * domain rules of this module, and mocking them out would leave the rules that
 * decide what a customer is charged untested. Same stance the workflow takes
 * about mocking only what crosses the border.
 */
function createShippingProviderMock() {
  return {
    quote: jest
      .fn<Promise<ShippingOption[]>, [ShippingQuoteRequest]>()
      .mockResolvedValue([SHIPPING_OPTION]),
  };
}

/**
 * The mail side of a transition, doubled at the module's own seam.
 *
 * OrderNotificationsService guarantees it never rejects, so these tests are
 * about WHEN it is called, not what it sends — the payload it builds and the
 * outage it swallows are its own spec's business.
 */
function createNotificationsMock() {
  return {
    orderPaid: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
    orderShipped: jest
      .fn<Promise<void>, [string]>()
      .mockResolvedValue(undefined),
    orderRefunded: jest
      .fn<Promise<void>, [string]>()
      .mockResolvedValue(undefined),
    orderCancelled: jest
      .fn<Promise<void>, [string]>()
      .mockResolvedValue(undefined),
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;
type ProductsMock = ReturnType<typeof createProductsMock>;
type StockMock = ReturnType<typeof createStockMock>;
type PaymentsMock = ReturnType<typeof createPaymentsMock>;
type ShippingMock = ReturnType<typeof createShippingProviderMock>;
type NotificationsMock = ReturnType<typeof createNotificationsMock>;

interface Mocks {
  prisma: PrismaMock;
  products: ProductsMock;
  stock: StockMock;
  payments: PaymentsMock;
  shipping: ShippingMock;
  notifications: NotificationsMock;
}

function createMocks(): Mocks {
  return {
    prisma: createPrismaMock(),
    products: createProductsMock(),
    stock: createStockMock(),
    payments: createPaymentsMock(),
    shipping: createShippingProviderMock(),
    notifications: createNotificationsMock(),
  };
}

function serviceWith({
  prisma,
  products,
  stock,
  payments,
  shipping,
  notifications,
}: Mocks) {
  return new OrdersService(
    prisma as unknown as PrismaService,
    products as unknown as ProductsService,
    stock as unknown as StockService,
    payments,
    new ShippingQuoteService(
      // Checkout never reads a cart through this service — it already has one.
      { getCart: jest.fn() } as unknown as CartService,
      shipping,
      DEFAULT_WEIGHT_GRAMS,
    ),
    notifications as unknown as OrderNotificationsService,
  );
}

/** Silences the deliberate error/warn logging, and hands back the spies. */
function muteLogger() {
  return {
    error: jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined),
    warn: jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined),
    log: jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined),
  };
}

function userWith(permissions: Permission[] = []): AuthenticatedUser {
  return { id: 'user-1', role: 'customer', permissions: new Set(permissions) };
}

/**
 * One sellable size, as the catalogue contract hands it over: the variant
 * carries the stock, its product carries the price and the weight.
 */
function sellableVariant(
  productId: string,
  priceCents: number,
  name = `Product ${productId}`,
  label = 'M',
) {
  return {
    id: `${productId}-${label.toLowerCase()}`,
    label,
    position: 1,
    stockQuantity: 10,
    product: {
      id: productId,
      name,
      slug: productId,
      priceCents,
      status: ProductStatus.ACTIVE,
      // Null on purpose: most of the catalogue predates the weight column, so
      // the default-weight path is the one the tests exercise by default.
      weightGrams: null as number | null,
    },
  };
}

function cartWith(items: { variantId: string; quantity: number }[]) {
  return { id: 'cart-1', items };
}

describe('OrdersService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('checkout', () => {
    function primeHappyPath(mocks: Mocks) {
      mocks.prisma.cart.findUnique.mockResolvedValue(
        cartWith([
          { variantId: 'p1-m', quantity: 2 },
          { variantId: 'p2-único', quantity: 1 },
        ]),
      );
      mocks.prisma.cartItem.deleteMany.mockResolvedValue({ count: 2 });
      mocks.products.findSellableByVariantIds.mockResolvedValue([
        sellableVariant('p1', 1000, 'Camiseta', 'M'),
        sellableVariant('p2', 2500, 'Caneca', 'Único'),
      ]);
    }

    it('freezes prices into the order and totals them', async () => {
      const mocks = createMocks();
      primeHappyPath(mocks);

      await serviceWith(mocks).checkout('user-1', checkoutInput());

      const [args] = mocks.prisma.order.create.mock.calls[0] as [
        {
          data: {
            userId: string;
            itemsSubtotalCents: number;
            shippingCents: number;
            totalCents: number;
            shippingMethodCode: string;
            shippingMethodName: string;
            shippingEtaDays: number | null;
            shippingLine1: string;
            items: {
              create: {
                productId: string;
                variantId: string;
                productName: string;
                variantLabel: string;
                unitPriceCents: number;
                quantity: number;
              }[];
            };
          };
        },
      ];
      expect(args.data.userId).toBe('user-1');
      // 2 × 1000 + 1 × 2500 — the snapshot's arithmetic, not the catalog's.
      expect(args.data.itemsSubtotalCents).toBe(4500);
      expect(args.data.shippingCents).toBe(1990);
      // The identity the database also holds as a CHECK constraint.
      expect(args.data.totalCents).toBe(6490);
      // Frozen beside the price: a number with no method is not auditable.
      expect(args.data.shippingMethodCode).toBe('padrao-brasil');
      expect(args.data.shippingMethodName).toBe('Entrega padrão');
      expect(args.data.shippingEtaDays).toBe(10);
      expect(args.data.shippingLine1).toBe(ADDRESS.line1);
      // The size travels beside the name, frozen: renaming M later must not
      // rewrite what this order says was bought.
      expect(args.data.items.create).toEqual([
        {
          productId: 'p1',
          variantId: 'p1-m',
          productName: 'Camiseta',
          variantLabel: 'M',
          unitPriceCents: 1000,
          quantity: 2,
        },
        {
          productId: 'p2',
          variantId: 'p2-único',
          productName: 'Caneca',
          variantLabel: 'Único',
          unitPriceCents: 2500,
          quantity: 1,
        },
      ]);
    });

    it('decrements every VARIANT inside the transaction', async () => {
      const mocks = createMocks();
      primeHappyPath(mocks);

      await serviceWith(mocks).checkout('user-1', checkoutInput());

      expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
      // Variant ids, not product ids: the size is what has stock now, and
      // taking units off the wrong one is the bug this asserts against.
      expect(mocks.stock.decrement).toHaveBeenCalledWith(
        'p1-m',
        2,
        expect.anything(),
      );
      expect(mocks.stock.decrement).toHaveBeenCalledWith(
        'p2-único',
        1,
        expect.anything(),
      );
    });

    it('opens a payment session after the transaction and stores it', async () => {
      const mocks = createMocks();
      primeHappyPath(mocks);

      const order = await serviceWith(mocks).checkout(
        'user-1',
        checkoutInput(),
      );

      // Items AND freight. This is the assertion the whole shipping module
      // exists to keep true: totalCents is what the buyer is charged, so
      // freight reaches the card without payments knowing shipping exists.
      expect(mocks.payments.createPayment).toHaveBeenCalledWith({
        orderId: 'order-1',
        amountCents: 6490,
        mode: undefined,
      });
      const [updateArgs] = mocks.prisma.order.updateMany.mock.calls[0] as [
        {
          where: { id: string; status: OrderStatus };
          data: {
            paymentRef: string;
            paymentUrl: string | null;
            paymentExpiresAt: Date;
          };
        },
      ];
      // Conditional on CREATED: a session must never be stapled to an order
      // that was cancelled while the provider call was in flight.
      expect(updateArgs.where).toEqual({
        id: 'order-1',
        status: OrderStatus.CREATED,
      });
      expect(updateArgs.data.paymentRef).toBe('cs_1');
      expect(updateArgs.data.paymentUrl).toBe('https://pay.example/cs_1');
      expect(updateArgs.data.paymentExpiresAt).toEqual(EXPIRES_AT);
      // The response carries the way to pay, which is not the same as the
      // stored columns: a client secret is never persisted.
      expect(order.payment).toEqual({
        mode: 'hosted',
        url: 'https://pay.example/cs_1',
        clientSecret: null,
        expiresAt: EXPIRES_AT,
      });
    });

    it('passes the requested checkout mode to the provider', async () => {
      const mocks = createMocks();
      primeHappyPath(mocks);
      mocks.payments.createPayment.mockResolvedValue(
        paymentSession({
          mode: 'embedded',
          url: null,
          clientSecret: 'cs_1_secret',
        }),
      );

      const order = await serviceWith(mocks).checkout(
        'user-1',
        checkoutInput({ paymentMode: 'embedded' }),
      );

      expect(mocks.payments.createPayment).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'embedded' }),
      );
      expect(order.payment?.clientSecret).toBe('cs_1_secret');
    });

    it('still creates the order when the provider is down', async () => {
      const mocks = createMocks();
      const logger = muteLogger();
      primeHappyPath(mocks);
      mocks.payments.createPayment.mockRejectedValue(new Error('stripe down'));

      const order = await serviceWith(mocks).checkout(
        'user-1',
        checkoutInput(),
      );

      // The order is real and the stock is committed; only the way to pay is
      // missing, and POST /orders/:id/pay exists to supply it. Failing the
      // checkout here would throw away a completed transaction.
      expect(order.id).toBe('order-1');
      expect(order.payment).toBeNull();
      expect(mocks.prisma.order.updateMany).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();
    });

    it('409s on an empty or missing cart without opening a transaction', async () => {
      const mocks = createMocks();
      mocks.prisma.cart.findUnique.mockResolvedValue(null);

      await expect(
        serviceWith(mocks).checkout('user-1', checkoutInput()),
      ).rejects.toThrow(ConflictException);

      mocks.prisma.cart.findUnique.mockResolvedValue(cartWith([]));
      await expect(
        serviceWith(mocks).checkout('user-1', checkoutInput()),
      ).rejects.toThrow(ConflictException);

      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('409s naming the pieces that are no longer for sale, before any write', async () => {
      const mocks = createMocks();
      mocks.prisma.cart.findUnique.mockResolvedValue(
        cartWith([
          { variantId: 'p1-m', quantity: 1 },
          { variantId: 'p2-m', quantity: 1 },
        ]),
      );
      const archived = sellableVariant('p2', 2500, 'Caneca');
      mocks.products.findSellableByVariantIds.mockResolvedValue([
        sellableVariant('p1', 1000),
        {
          ...archived,
          product: { ...archived.product, status: ProductStatus.ARCHIVED },
        },
      ]);

      const attempt = serviceWith(mocks).checkout('user-1', checkoutInput());

      await expect(attempt).rejects.toThrow(ConflictException);
      // The PIECE, not just an id: "Caneca" alone would be ambiguous the
      // moment a product has more than one size.
      await expect(attempt).rejects.toMatchObject({
        response: expect.objectContaining({
          unavailableItems: [
            {
              variantId: 'p2-m',
              productId: 'p2',
              productName: 'Caneca',
              variantLabel: 'M',
            },
          ],
        }) as unknown,
      });
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rolls back and 409s naming the items that lost the stock race', async () => {
      const mocks = createMocks();
      primeHappyPath(mocks);
      mocks.stock.decrement.mockResolvedValueOnce(true);
      mocks.stock.decrement.mockResolvedValueOnce(false);

      const attempt = serviceWith(mocks).checkout('user-1', checkoutInput());

      await expect(attempt).rejects.toThrow(ConflictException);
      await expect(attempt).rejects.toMatchObject({
        response: expect.objectContaining({
          unavailableItems: [
            {
              variantId: 'p2-único',
              productId: 'p2',
              productName: 'Caneca',
              variantLabel: 'Único',
            },
          ],
        }) as unknown,
      });
      // The throw happens inside $transaction, so Prisma rolls everything
      // back; the order must never have been created.
      expect(mocks.prisma.order.create).not.toHaveBeenCalled();
      expect(mocks.payments.createPayment).not.toHaveBeenCalled();
    });

    it('quotes with resolved weights and the items subtotal', async () => {
      const mocks = createMocks();
      primeHappyPath(mocks);

      await serviceWith(mocks).checkout('user-1', checkoutInput());

      // Weightless products resolve to the configured default BEFORE the
      // boundary, so no provider — ours or a carrier's — ever sees a null.
      expect(mocks.shipping.quote).toHaveBeenCalledWith({
        destination: { postalCode: ADDRESS.postalCode },
        subtotalCents: 4500,
        items: [
          {
            productId: 'p1',
            quantity: 2,
            unitPriceCents: 1000,
            weightGrams: DEFAULT_WEIGHT_GRAMS,
          },
          {
            productId: 'p2',
            quantity: 1,
            unitPriceCents: 2500,
            weightGrams: DEFAULT_WEIGHT_GRAMS,
          },
        ],
      });
    });

    it('carries a real product weight through untouched', async () => {
      const mocks = createMocks();
      primeHappyPath(mocks);
      const shirt = sellableVariant('p1', 1000, 'Camiseta', 'M');
      mocks.products.findSellableByVariantIds.mockResolvedValue([
        { ...shirt, product: { ...shirt.product, weightGrams: 350 } },
        sellableVariant('p2', 2500, 'Caneca', 'Único'),
      ]);

      await serviceWith(mocks).checkout('user-1', checkoutInput());

      const [request] = mocks.shipping.quote.mock.calls[0];
      expect(request.items[0].weightGrams).toBe(350);
      expect(request.items[1].weightGrams).toBe(DEFAULT_WEIGHT_GRAMS);
    });

    it('409s when the quoted price no longer matches, before any write', async () => {
      const mocks = createMocks();
      primeHappyPath(mocks);
      mocks.shipping.quote.mockResolvedValue([
        { ...SHIPPING_OPTION, priceCents: 2990 },
      ]);

      // The customer was shown 19.90 and the table now says 29.90. Charging
      // the new price silently would never undercharge us — it would charge
      // them something they never saw.
      const attempt = serviceWith(mocks).checkout(
        'user-1',
        checkoutInput({ quotedShippingCents: 1990 }),
      );

      await expect(attempt).rejects.toThrow(ConflictException);
      await expect(attempt).rejects.toMatchObject({
        response: expect.objectContaining({
          shippingOptions: [expect.objectContaining({ priceCents: 2990 })],
        }) as unknown,
      });
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
      expect(mocks.prisma.order.create).not.toHaveBeenCalled();
    });

    it('409s when the chosen option is not on offer', async () => {
      const mocks = createMocks();
      primeHappyPath(mocks);

      const attempt = serviceWith(mocks).checkout(
        'user-1',
        checkoutInput({ shippingOptionCode: 'expresso-lua' }),
      );

      await expect(attempt).rejects.toThrow(ConflictException);
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('409s when nothing serves the postal code', async () => {
      const mocks = createMocks();
      primeHappyPath(mocks);
      // An empty list is the provider saying "we do not deliver there" — a
      // fact about the address, not a failure.
      mocks.shipping.quote.mockResolvedValue([]);

      const attempt = serviceWith(mocks).checkout('user-1', checkoutInput());

      await expect(attempt).rejects.toThrow(ConflictException);
      await expect(attempt).rejects.toMatchObject({
        response: expect.objectContaining({ shippingOptions: [] }) as unknown,
      });
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('503s and creates nothing when shipping cannot be quoted', async () => {
      const mocks = createMocks();
      const logger = muteLogger();
      primeHappyPath(mocks);
      mocks.shipping.quote.mockRejectedValue(new Error('carrier down'));

      // The opposite of the payment-provider outage above, on purpose: an
      // order with no session is recoverable through /pay, but an order with
      // no freight has the wrong total and nothing can repair it afterwards.
      await expect(
        serviceWith(mocks).checkout('user-1', checkoutInput()),
      ).rejects.toThrow(ServiceUnavailableException);

      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
      expect(mocks.stock.decrement).not.toHaveBeenCalled();
      expect(mocks.prisma.order.create).not.toHaveBeenCalled();
      expect(mocks.payments.createPayment).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();
    });

    it('stores free shipping as a zero price with the method still frozen', async () => {
      const mocks = createMocks();
      primeHappyPath(mocks);
      mocks.shipping.quote.mockResolvedValue([
        { ...SHIPPING_OPTION, priceCents: 0 },
      ]);

      await serviceWith(mocks).checkout(
        'user-1',
        checkoutInput({ quotedShippingCents: 0 }),
      );

      const [args] = mocks.prisma.order.create.mock.calls[0] as [
        {
          data: {
            shippingCents: number;
            totalCents: number;
            shippingMethodCode: string;
          };
        },
      ];
      expect(args.data.shippingCents).toBe(0);
      expect(args.data.totalCents).toBe(4500);
      // What tells free shipping apart from an order that predates freight.
      expect(args.data.shippingMethodCode).toBe('padrao-brasil');
    });

    it('409s when a concurrent checkout already consumed the cart', async () => {
      const mocks = createMocks();
      primeHappyPath(mocks);
      // Both requests read the same 2 items; the loser's delete finds 0 rows.
      mocks.prisma.cartItem.deleteMany.mockResolvedValue({ count: 0 });

      await expect(
        serviceWith(mocks).checkout('user-1', checkoutInput()),
      ).rejects.toThrow(ConflictException);
      expect(mocks.stock.decrement).not.toHaveBeenCalled();
      expect(mocks.prisma.order.create).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('scopes a plain customer to their own orders', async () => {
      const mocks = createMocks();

      await serviceWith(mocks).list(userWith(), {});

      const [args] = mocks.prisma.order.findMany.mock.calls[0] as [
        { where: { userId?: string } },
      ];
      expect(args.where.userId).toBe('user-1');
    });

    it('lets orders.read see everything and filter by user and status', async () => {
      const mocks = createMocks();

      await serviceWith(mocks).list(userWith([PERMISSIONS.ORDERS_READ]), {
        userId: 'user-2',
        status: OrderStatus.PAID,
      });

      const [args] = mocks.prisma.order.findMany.mock.calls[0] as [
        { where: { userId?: string; status?: OrderStatus } },
      ];
      expect(args.where).toEqual({
        userId: 'user-2',
        status: OrderStatus.PAID,
      });
    });

    it('403s a customer trying to filter by userId', async () => {
      const mocks = createMocks();

      await expect(
        serviceWith(mocks).list(userWith(), { userId: 'user-2' }),
      ).rejects.toThrow(ForbiddenException);
      expect(mocks.prisma.order.findMany).not.toHaveBeenCalled();
    });

    it('paginates with clamped page size', async () => {
      const mocks = createMocks();

      const result = await serviceWith(mocks).list(userWith(), {
        page: 2,
        perPage: 500,
      });

      const [args] = mocks.prisma.order.findMany.mock.calls[0] as [
        { skip: number; take: number },
      ];
      expect(args.take).toBe(100);
      expect(args.skip).toBe(100);
      expect(result).toEqual({ items: [], total: 0, page: 2, perPage: 100 });
    });
  });

  describe('findOne', () => {
    it('scopes the lookup to the owner for a plain customer — foreign is 404', async () => {
      const mocks = createMocks();
      mocks.prisma.order.findFirst.mockResolvedValue(null);

      await expect(
        serviceWith(mocks).findOne(userWith(), 'order-9'),
      ).rejects.toThrow(NotFoundException);

      const [args] = mocks.prisma.order.findFirst.mock.calls[0] as [
        { where: { id: string; userId?: string } },
      ];
      // 404 and not 403: the query itself cannot see foreign orders, so the
      // response never confirms the id exists.
      expect(args.where).toEqual({ id: 'order-9', userId: 'user-1' });
    });

    it('does not scope for orders.read', async () => {
      const mocks = createMocks();
      mocks.prisma.order.findFirst.mockResolvedValue(orderRow());

      await serviceWith(mocks).findOne(
        userWith([PERMISSIONS.ORDERS_READ]),
        'order-1',
      );

      const [args] = mocks.prisma.order.findFirst.mock.calls[0] as [
        { where: { id: string; userId?: string } },
      ];
      expect(args.where).toEqual({ id: 'order-1' });
    });
  });

  describe('cancel', () => {
    function primeCancellable(mocks: Mocks) {
      mocks.prisma.order.findFirst.mockResolvedValue(
        orderRow({
          items: [
            {
              productId: 'p1',
              variantId: 'p1-m',
              productName: 'Camiseta',
              variantLabel: 'M',
              unitPriceCents: 1000,
              quantity: 2,
            },
          ],
        }),
      );
      mocks.prisma.order.updateMany.mockResolvedValue({ count: 1 });
    }

    it('cancels an own CREATED order and restocks inside the transaction', async () => {
      const mocks = createMocks();
      primeCancellable(mocks);

      await serviceWith(mocks).cancel(userWith(), 'order-1');

      const [args] = mocks.prisma.order.updateMany.mock.calls[0] as [
        {
          where: { id: string; status: OrderStatus };
          data: { status: OrderStatus };
        },
      ];
      // Conditional on status so a cancel racing a mark-paid cannot revoke a
      // paid order: whoever's UPDATE matches first wins, the other sees 0.
      expect(args.where).toEqual({
        id: 'order-1',
        status: OrderStatus.CREATED,
      });
      expect(args.data.status).toBe(OrderStatus.CANCELLED);
      // The size the units came off, not the product: putting them back on
      // the wrong variant would be an invisible oversell of another size.
      expect(mocks.stock.restock).toHaveBeenCalledWith(
        'p1-m',
        2,
        expect.anything(),
      );
    });

    it('409s without restocking when the order is past CREATED', async () => {
      const mocks = createMocks();
      primeCancellable(mocks);
      mocks.prisma.order.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        serviceWith(mocks).cancel(userWith(), 'order-1'),
      ).rejects.toThrow(ConflictException);
      expect(mocks.stock.restock).not.toHaveBeenCalled();
    });

    it("403s an operator who can SEE someone else's order but not cancel it", async () => {
      const mocks = createMocks();
      // orders.read widens visibility, so the scoped query finds the foreign
      // order — refusing must then be a 403, not a fake 404: the GET route
      // already confirms this order exists to this caller.
      mocks.prisma.order.findFirst.mockResolvedValue(
        orderRow({ userId: 'user-2' }),
      );

      await expect(
        serviceWith(mocks).cancel(
          userWith([PERMISSIONS.ORDERS_READ]),
          'order-1',
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(mocks.prisma.order.updateMany).not.toHaveBeenCalled();
      expect(mocks.stock.restock).not.toHaveBeenCalled();
    });

    it("404s on someone else's order without orders.cancel", async () => {
      const mocks = createMocks();
      mocks.prisma.order.findFirst.mockResolvedValue(null);

      await expect(
        serviceWith(mocks).cancel(userWith(), 'order-2'),
      ).rejects.toThrow(NotFoundException);

      const [args] = mocks.prisma.order.findFirst.mock.calls[0] as [
        { where: { id: string; userId?: string } },
      ];
      expect(args.where).toEqual({ id: 'order-2', userId: 'user-1' });
    });

    it('lets orders.cancel act on anyone’s order', async () => {
      const mocks = createMocks();
      primeCancellable(mocks);

      await serviceWith(mocks).cancel(
        userWith([PERMISSIONS.ORDERS_CANCEL]),
        'order-1',
      );

      const [args] = mocks.prisma.order.findFirst.mock.calls[0] as [
        { where: { id: string; userId?: string } },
      ];
      expect(args.where).toEqual({ id: 'order-1' });
    });

    it('expires the payment session so the cancelled order stops being payable', async () => {
      const mocks = createMocks();
      primeCancellable(mocks);
      mocks.prisma.order.findFirst.mockResolvedValue(
        orderRow({ paymentRef: 'cs_1' }),
      );

      await serviceWith(mocks).cancel(userWith(), 'order-1');

      // The stock just went back on the shelf and may be sold to someone
      // else; leaving the old session payable is how you get money for goods
      // that are gone.
      expect(mocks.payments.expirePayment).toHaveBeenCalledWith('cs_1');
    });

    it('cancels anyway when the provider will not expire the session', async () => {
      const mocks = createMocks();
      const logger = muteLogger();
      primeCancellable(mocks);
      mocks.prisma.order.findFirst.mockResolvedValue(
        orderRow({ paymentRef: 'cs_1' }),
      );
      mocks.payments.expirePayment.mockRejectedValue(new Error('stripe down'));

      // Cancelling is the customer's action; it cannot be held hostage to a
      // third party being reachable.
      await expect(
        serviceWith(mocks).cancel(userWith(), 'order-1'),
      ).resolves.toBeDefined();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('pay', () => {
    function primeOrder(mocks: Mocks, overrides: Partial<OrderRow> = {}) {
      mocks.prisma.order.findFirst.mockResolvedValue(orderRow(overrides));
      mocks.prisma.order.findUnique.mockResolvedValue(orderRow(overrides));
      // The claiming write that attaches a new session succeeds by default.
      mocks.prisma.order.updateMany.mockResolvedValue({ count: 1 });
    }

    function openSession(session = paymentSession()): SessionLookup {
      return { state: 'open', session };
    }

    it('issues a session for an order that has none', async () => {
      const mocks = createMocks();
      primeOrder(mocks);

      const result = await serviceWith(mocks).pay(userWith(), 'order-1');

      // The stored grand total, freight included — a recovery session must
      // never re-issue for the items alone.
      expect(mocks.payments.createPayment).toHaveBeenCalledWith({
        orderId: 'order-1',
        amountCents: 6490,
        mode: undefined,
      });
      expect(result.payment.url).toBe('https://pay.example/cs_1');
    });

    it('hands back the open session rather than opening a second one', async () => {
      const mocks = createMocks();
      primeOrder(mocks, { paymentRef: 'cs_1' });
      mocks.payments.getPayment.mockResolvedValue(openSession());

      const result = await serviceWith(mocks).pay(userWith(), 'order-1');

      // Two open sessions for one order are two ways to charge the same
      // person — this reuse is the main defence against that.
      expect(mocks.payments.getPayment).toHaveBeenCalledWith('cs_1');
      expect(mocks.payments.createPayment).not.toHaveBeenCalled();
      expect(result.payment.url).toBe('https://pay.example/cs_1');
    });

    it('409s instead of re-issuing when the session was already paid', async () => {
      const mocks = createMocks();
      // The order is still CREATED only because the confirmation webhook has
      // not landed. Before this guard, /pay read "not open" as "make another
      // one" and handed the buyer a second way to pay the same order — a real
      // double charge, reachable with nothing worse than webhook latency.
      primeOrder(mocks, { paymentRef: 'cs_1' });
      mocks.payments.getPayment.mockResolvedValue({ state: 'completed' });

      await expect(
        serviceWith(mocks).pay(userWith(), 'order-1'),
      ).rejects.toThrow(ConflictException);
      expect(mocks.payments.createPayment).not.toHaveBeenCalled();
    });

    it('expires the old session when a different mode is asked for', async () => {
      const mocks = createMocks();
      primeOrder(mocks, { paymentRef: 'cs_1' });
      mocks.payments.getPayment.mockResolvedValue(openSession());
      mocks.payments.createPayment.mockResolvedValue(
        paymentSession({
          providerRef: 'cs_2',
          mode: 'embedded',
          url: null,
          clientSecret: 'cs_2_secret',
        }),
      );

      const result = await serviceWith(mocks).pay(
        userWith(),
        'order-1',
        'embedded',
      );

      // Replacing without expiring would leave the hosted one payable too.
      expect(mocks.payments.expirePayment).toHaveBeenCalledWith('cs_1');
      expect(result.payment.clientSecret).toBe('cs_2_secret');
    });

    it('aborts the mode switch when the old session will not expire', async () => {
      const mocks = createMocks();
      muteLogger();
      primeOrder(mocks, { paymentRef: 'cs_1' });
      mocks.payments.getPayment.mockResolvedValue(openSession());
      mocks.payments.expirePayment.mockRejectedValue(new Error('stripe down'));

      // Best-effort is right in cancel(), where nothing is created afterwards.
      // Here the swallowed failure would be the precondition for the very thing
      // expiring exists to prevent: two payable sessions on one order.
      await expect(
        serviceWith(mocks).pay(userWith(), 'order-1', 'embedded'),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(mocks.payments.createPayment).not.toHaveBeenCalled();
    });

    it('refuses to attach a session to an order that moved meanwhile', async () => {
      const mocks = createMocks();
      muteLogger();
      primeOrder(mocks);
      // Cancelled (or paid) while createPayment was in flight: the claiming
      // write matches nothing.
      mocks.prisma.order.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        serviceWith(mocks).pay(userWith(), 'order-1'),
      ).rejects.toThrow(ConflictException);

      const [args] = mocks.prisma.order.updateMany.mock.calls[0] as [
        { where: { id: string; status: OrderStatus } },
      ];
      expect(args.where).toEqual({
        id: 'order-1',
        status: OrderStatus.CREATED,
      });
      // The orphan is closed rather than left open against a settled order.
      expect(mocks.payments.expirePayment).toHaveBeenCalledWith('cs_1');
    });

    it('409s an order that is no longer CREATED', async () => {
      const mocks = createMocks();
      primeOrder(mocks, { status: OrderStatus.PAID });

      await expect(
        serviceWith(mocks).pay(userWith(), 'order-1'),
      ).rejects.toThrow(ConflictException);
      expect(mocks.payments.createPayment).not.toHaveBeenCalled();
    });

    it("404s an invisible order and 403s a visible one that isn't the caller's", async () => {
      const invisible = createMocks();
      invisible.prisma.order.findFirst.mockResolvedValue(null);

      await expect(
        serviceWith(invisible).pay(userWith(), 'order-9'),
      ).rejects.toThrow(NotFoundException);

      const visible = createMocks();
      visible.prisma.order.findFirst.mockResolvedValue(
        orderRow({ userId: 'user-2' }),
      );

      await expect(
        serviceWith(visible).pay(
          userWith([PERMISSIONS.ORDERS_READ]),
          'order-1',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('503s when the provider cannot be reached', async () => {
      const mocks = createMocks();
      const logger = muteLogger();
      primeOrder(mocks);
      mocks.payments.createPayment.mockRejectedValue(new Error('stripe down'));

      // Unlike checkout, issuing the session is the entire point of the
      // request — there is nothing worth answering 200 about.
      await expect(
        serviceWith(mocks).pay(userWith(), 'order-1'),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('refund', () => {
    function primePaid(mocks: Mocks, overrides: Partial<OrderRow> = {}) {
      mocks.prisma.order.findUnique.mockResolvedValue(
        orderRow({
          status: OrderStatus.PAID,
          paymentIntentRef: 'pi_1',
          ...overrides,
        }),
      );
      mocks.prisma.order.updateMany.mockResolvedValue({ count: 1 });
      mocks.prisma.orderItem.findMany.mockResolvedValue([
        { variantId: 'p1-m', quantity: 2 },
      ]);
    }

    it('refunds against the intent, marks REFUNDED and restocks', async () => {
      const mocks = createMocks();
      primePaid(mocks);

      await serviceWith(mocks).refund('order-1');

      expect(mocks.payments.refund).toHaveBeenCalledWith({
        paymentIntentRef: 'pi_1',
      });
      const [args] = mocks.prisma.order.updateMany.mock.calls[0] as [
        {
          where: { id: string; status: OrderStatus };
          data: { status: OrderStatus; refundRef: string; refundedAt: Date };
        },
      ];
      // Conditional on PAID, so the route and the provider's own
      // charge.refunded event cannot both restock.
      expect(args.where).toEqual({ id: 'order-1', status: OrderStatus.PAID });
      expect(args.data.status).toBe(OrderStatus.REFUNDED);
      expect(args.data.refundRef).toBe('re_1');
      // The size the units came off, not the product: putting them back on
      // the wrong variant would be an invisible oversell of another size.
      expect(mocks.stock.restock).toHaveBeenCalledWith(
        'p1-m',
        2,
        expect.anything(),
      );
    });

    it.each([
      OrderStatus.CREATED,
      OrderStatus.SHIPPED,
      OrderStatus.DELIVERED,
      OrderStatus.REFUNDED,
    ])('409s a %s order without calling the provider', async (status) => {
      const mocks = createMocks();
      primePaid(mocks, { status });

      await expect(serviceWith(mocks).refund('order-1')).rejects.toThrow(
        ConflictException,
      );
      expect(mocks.payments.refund).not.toHaveBeenCalled();
    });

    it('409s an order that was marked paid by hand', async () => {
      const mocks = createMocks();
      primePaid(mocks, { paymentIntentRef: null });

      // A bank transfer or a Pix outside the gateway leaves nothing for the
      // provider to reverse; asking it to would be asking for money it never
      // took.
      await expect(serviceWith(mocks).refund('order-1')).rejects.toThrow(
        /recorded as paid manually/,
      );
      expect(mocks.payments.refund).not.toHaveBeenCalled();
    });

    it('shouts when the order moved after the money went back', async () => {
      const mocks = createMocks();
      const logger = muteLogger();
      primePaid(mocks);
      mocks.prisma.order.updateMany.mockResolvedValue({ count: 0 });

      await expect(serviceWith(mocks).refund('order-1')).rejects.toThrow(
        ConflictException,
      );
      // The refund at the provider already happened, so this is a money
      // problem, not a routine conflict.
      expect(logger.error).toHaveBeenCalled();
      expect(mocks.stock.restock).not.toHaveBeenCalled();
    });

    it('markRefunded answers false instead of throwing on a non-PAID order', async () => {
      const mocks = createMocks();
      mocks.prisma.order.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        serviceWith(mocks).markRefunded('order-1', 're_1'),
      ).resolves.toBe(false);
      expect(mocks.stock.restock).not.toHaveBeenCalled();
    });
  });

  describe('transitions', () => {
    it.each([
      ['markPaid', OrderStatus.CREATED, OrderStatus.PAID, 'paidAt'],
      ['ship', OrderStatus.PAID, OrderStatus.SHIPPED, 'shippedAt'],
      ['deliver', OrderStatus.SHIPPED, OrderStatus.DELIVERED, 'deliveredAt'],
    ] as const)(
      '%s moves %s → %s behind a conditional UPDATE stamping %s',
      async (method, from, to, timestampField) => {
        const mocks = createMocks();
        mocks.prisma.order.updateMany.mockResolvedValue({ count: 1 });

        await serviceWith(mocks)[method]('order-1');

        const [args] = mocks.prisma.order.updateMany.mock.calls[0] as [
          {
            where: { id: string; status: OrderStatus };
            data: Record<string, unknown>;
          },
        ];
        expect(args.where).toEqual({ id: 'order-1', status: from });
        expect(args.data.status).toBe(to);
        expect(args.data[timestampField]).toBeInstanceOf(Date);
      },
    );

    it('records the provider intent when the webhook supplies one', async () => {
      const mocks = createMocks();
      mocks.prisma.order.updateMany.mockResolvedValue({ count: 1 });

      await serviceWith(mocks).markPaid('order-1', 'pi_1');

      const [args] = mocks.prisma.order.updateMany.mock.calls[0] as [
        { data: { paymentIntentRef?: string } },
      ];
      // Refunds are issued against the intent, so this is the one chance to
      // learn it — the manual mark-paid route has no intent to record.
      expect(args.data.paymentIntentRef).toBe('pi_1');
    });

    it('404s a transition on an order that does not exist', async () => {
      const mocks = createMocks();
      mocks.prisma.order.updateMany.mockResolvedValue({ count: 0 });
      mocks.prisma.order.findUnique.mockResolvedValue(null);

      await expect(serviceWith(mocks).markPaid('ghost')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('409s a transition from the wrong state, telling the current one', async () => {
      const mocks = createMocks();
      mocks.prisma.order.updateMany.mockResolvedValue({ count: 0 });
      mocks.prisma.order.findUnique.mockResolvedValue(
        orderRow({ status: OrderStatus.CANCELLED }),
      );

      await expect(serviceWith(mocks).ship('order-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('stamps tracking details when shipping with them', async () => {
      const mocks = createMocks();

      await serviceWith(mocks).ship('order-1', {
        trackingCode: 'BR123456789BR',
        trackingUrl: 'https://rastreio.example/BR123456789BR',
      });

      const [args] = mocks.prisma.order.updateMany.mock.calls[0] as [
        {
          where: { id: string; status: OrderStatus };
          data: { trackingCode?: string; trackingUrl?: string };
        },
      ];
      // Still the same conditional UPDATE — tracking rides along on the
      // existing transition rather than becoming a state of its own.
      expect(args.where).toEqual({
        id: 'order-1',
        status: OrderStatus.PAID,
      });
      expect(args.data.trackingCode).toBe('BR123456789BR');
      expect(args.data.trackingUrl).toBe(
        'https://rastreio.example/BR123456789BR',
      );
    });

    it('ships without tracking, leaving the columns alone', async () => {
      const mocks = createMocks();

      // A courier or a hand-off arranged by phone has no code to give, and
      // that is a real shipment — requiring one would block it.
      await serviceWith(mocks).ship('order-1');

      const [args] = mocks.prisma.order.updateMany.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(args.data).not.toHaveProperty('trackingCode');
      expect(args.data).not.toHaveProperty('trackingUrl');
    });
  });

  /**
   * The idempotency claim of docs/specs/order-emails.md, at the only level
   * where it is true: every transition is a conditional UPDATE, so "a row
   * changed" is the same thing as "this happened just now, on this call".
   * Emails hang off that answer and nothing else — no table, no dedupe key.
   */
  describe('lifecycle emails', () => {
    /** Zero rows updated, and the order still exists — a losing transition. */
    function primeLostRace(mocks: Mocks, status: OrderStatus) {
      mocks.prisma.order.updateMany.mockResolvedValue({ count: 0 });
      mocks.prisma.order.findUnique.mockResolvedValue(orderRow({ status }));
    }

    describe('on payment', () => {
      it('confirms the order once it really moved to PAID', async () => {
        const mocks = createMocks();

        await serviceWith(mocks).markPaid('order-1', 'pi_1');

        expect(mocks.notifications.orderPaid).toHaveBeenCalledWith('order-1');
      });

      it('sends nothing when the order was already PAID', async () => {
        const mocks = createMocks();
        primeLostRace(mocks, OrderStatus.PAID);

        // The webhook redelivery path: payment_events stops most of these
        // upstream, and the ones that get through land here as a 409.
        await expect(serviceWith(mocks).markPaid('order-1')).rejects.toThrow(
          ConflictException,
        );
        expect(mocks.notifications.orderPaid).not.toHaveBeenCalled();
      });

      it('sends nothing when there is no such order', async () => {
        const mocks = createMocks();
        mocks.prisma.order.updateMany.mockResolvedValue({ count: 0 });
        mocks.prisma.order.findUnique.mockResolvedValue(null);

        await expect(serviceWith(mocks).markPaid('order-1')).rejects.toThrow(
          NotFoundException,
        );
        expect(mocks.notifications.orderPaid).not.toHaveBeenCalled();
      });
    });

    describe('on shipment', () => {
      it('announces the shipment once it really moved to SHIPPED', async () => {
        const mocks = createMocks();

        await serviceWith(mocks).ship('order-1', {
          trackingCode: 'BR123456789BR',
        });

        expect(mocks.notifications.orderShipped).toHaveBeenCalledWith(
          'order-1',
        );
      });

      it('sends nothing on a second ship of the same order', async () => {
        const mocks = createMocks();
        primeLostRace(mocks, OrderStatus.SHIPPED);

        await expect(serviceWith(mocks).ship('order-1')).rejects.toThrow(
          ConflictException,
        );
        expect(mocks.notifications.orderShipped).not.toHaveBeenCalled();
      });
    });

    describe('on delivery', () => {
      it('sends nothing at all', async () => {
        const mocks = createMocks();

        await serviceWith(mocks).deliver('order-1');

        // Deliberate, not an oversight (docs/specs/order-emails.md): the box
        // is already in the customer's hands by then.
        expect(mocks.notifications.orderPaid).not.toHaveBeenCalled();
        expect(mocks.notifications.orderShipped).not.toHaveBeenCalled();
        expect(mocks.notifications.orderRefunded).not.toHaveBeenCalled();
        expect(mocks.notifications.orderCancelled).not.toHaveBeenCalled();
      });
    });

    describe('on refund', () => {
      function primeRefundable(mocks: Mocks) {
        mocks.prisma.order.findUnique.mockResolvedValue(
          orderRow({ status: OrderStatus.PAID, paymentIntentRef: 'pi_1' }),
        );
      }

      it('tells the customer their money is on the way back', async () => {
        const mocks = createMocks();
        primeRefundable(mocks);

        await serviceWith(mocks).refund('order-1');

        expect(mocks.notifications.orderRefunded).toHaveBeenCalledWith(
          'order-1',
        );
      });

      it('sends nothing when the refund did not apply', async () => {
        const logger = muteLogger();
        const mocks = createMocks();
        primeRefundable(mocks);
        mocks.prisma.order.updateMany.mockResolvedValue({ count: 0 });

        await expect(serviceWith(mocks).refund('order-1')).rejects.toThrow(
          ConflictException,
        );
        expect(mocks.notifications.orderRefunded).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalled();
      });

      it('sends from the webhook seam too, when it applies', async () => {
        const mocks = createMocks();

        await expect(
          serviceWith(mocks).markRefunded('order-1', 're_1'),
        ).resolves.toBe(true);
        expect(mocks.notifications.orderRefunded).toHaveBeenCalledWith(
          'order-1',
        );
      });

      it('stays quiet when the webhook finds the order already refunded', async () => {
        const mocks = createMocks();
        mocks.prisma.order.updateMany.mockResolvedValue({ count: 0 });

        // charge.refunded arriving after POST /orders/:id/refund already did
        // the work — one refund, one email.
        await expect(
          serviceWith(mocks).markRefunded('order-1', 're_1'),
        ).resolves.toBe(false);
        expect(mocks.notifications.orderRefunded).not.toHaveBeenCalled();
      });
    });

    describe('on cancellation', () => {
      function primeCancellable(mocks: Mocks, userId = 'user-1') {
        mocks.prisma.order.findFirst.mockResolvedValue(orderRow({ userId }));
        mocks.prisma.order.updateMany.mockResolvedValue({ count: 1 });
      }

      it('stays quiet when customers cancel their own order', async () => {
        const mocks = createMocks();
        primeCancellable(mocks);

        await serviceWith(mocks).cancel(userWith(), 'order-1');

        // They clicked the button and got a 200 — mailing them about it is
        // telling someone what they just did.
        expect(mocks.notifications.orderCancelled).not.toHaveBeenCalled();
      });

      it('warns the customer when someone else cancels their order', async () => {
        const mocks = createMocks();
        primeCancellable(mocks, 'someone-else');

        await serviceWith(mocks).cancel(
          userWith([PERMISSIONS.ORDERS_CANCEL]),
          'order-1',
        );

        // This is the only case the customer could not have known about.
        expect(mocks.notifications.orderCancelled).toHaveBeenCalledWith(
          'order-1',
        );
      });

      it('sends nothing when the cancellation lost the race', async () => {
        const mocks = createMocks();
        primeCancellable(mocks, 'someone-else');
        mocks.prisma.order.updateMany.mockResolvedValue({ count: 0 });

        await expect(
          serviceWith(mocks).cancel(
            userWith([PERMISSIONS.ORDERS_CANCEL]),
            'order-1',
          ),
        ).rejects.toThrow(ConflictException);
        expect(mocks.notifications.orderCancelled).not.toHaveBeenCalled();
      });
    });
  });
});
