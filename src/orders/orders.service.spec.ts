import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { type Permission, PERMISSIONS } from '../auth/authz/permissions';
import type { ProductsService } from '../catalog/products.service';
import type { StockService } from '../catalog/stock.service';
import { OrderStatus, ProductStatus } from '../generated/prisma/enums';
import type { PrismaService } from '../prisma/prisma.service';
import { OrdersService, type ShippingAddress } from './orders.service';

const ADDRESS: ShippingAddress = {
  line1: 'Rua das Flores, 123',
  city: 'Curitiba',
  state: 'PR',
  postalCode: '80000-000',
};

interface OrderRow {
  id: string;
  userId: string;
  status: OrderStatus;
  totalCents: number;
  paymentRef: string | null;
  items: {
    productId: string;
    productName: string;
    unitPriceCents: number;
    quantity: number;
  }[];
}

function orderRow(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: 'order-1',
    userId: 'user-1',
    status: OrderStatus.CREATED,
    totalCents: 4500,
    paymentRef: null,
    items: [],
    ...overrides,
  };
}

function createPrismaMock() {
  const base = {
    cart: {
      findUnique: jest.fn<
        Promise<{
          id: string;
          items: { productId: string; quantity: number }[];
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
        .mockResolvedValue(orderRow({ paymentRef: 'fake_ref' })),
      updateMany: jest.fn<Promise<{ count: number }>, [unknown]>(),
      findFirst: jest.fn<Promise<OrderRow | null>, [unknown]>(),
      findUnique: jest
        .fn<Promise<OrderRow | null>, [unknown]>()
        .mockResolvedValue(orderRow()),
      findMany: jest.fn<Promise<OrderRow[]>, [unknown]>().mockResolvedValue([]),
      count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
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
    findByIds: jest.fn<
      Promise<
        {
          id: string;
          name: string;
          slug: string;
          priceCents: number;
          status: ProductStatus;
          stockQuantity: number;
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
      .fn<Promise<{ providerRef: string }>, [unknown]>()
      .mockResolvedValue({ providerRef: 'fake_ref' }),
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;
type ProductsMock = ReturnType<typeof createProductsMock>;
type StockMock = ReturnType<typeof createStockMock>;
type PaymentsMock = ReturnType<typeof createPaymentsMock>;

interface Mocks {
  prisma: PrismaMock;
  products: ProductsMock;
  stock: StockMock;
  payments: PaymentsMock;
}

function createMocks(): Mocks {
  return {
    prisma: createPrismaMock(),
    products: createProductsMock(),
    stock: createStockMock(),
    payments: createPaymentsMock(),
  };
}

function serviceWith({ prisma, products, stock, payments }: Mocks) {
  return new OrdersService(
    prisma as unknown as PrismaService,
    products as unknown as ProductsService,
    stock as unknown as StockService,
    payments,
  );
}

function userWith(permissions: Permission[] = []): AuthenticatedUser {
  return { id: 'user-1', role: 'customer', permissions: new Set(permissions) };
}

function sellableProduct(
  id: string,
  priceCents: number,
  name = `Product ${id}`,
) {
  return {
    id,
    name,
    slug: id,
    priceCents,
    status: ProductStatus.ACTIVE,
    stockQuantity: 10,
  };
}

function cartWith(items: { productId: string; quantity: number }[]) {
  return { id: 'cart-1', items };
}

describe('OrdersService', () => {
  describe('checkout', () => {
    function primeHappyPath(mocks: Mocks) {
      mocks.prisma.cart.findUnique.mockResolvedValue(
        cartWith([
          { productId: 'p1', quantity: 2 },
          { productId: 'p2', quantity: 1 },
        ]),
      );
      mocks.prisma.cartItem.deleteMany.mockResolvedValue({ count: 2 });
      mocks.products.findByIds.mockResolvedValue([
        sellableProduct('p1', 1000, 'Camiseta'),
        sellableProduct('p2', 2500, 'Caneca'),
      ]);
    }

    it('freezes prices into the order and totals them', async () => {
      const mocks = createMocks();
      primeHappyPath(mocks);

      await serviceWith(mocks).checkout('user-1', ADDRESS);

      const [args] = mocks.prisma.order.create.mock.calls[0] as [
        {
          data: {
            userId: string;
            totalCents: number;
            shippingLine1: string;
            items: {
              create: {
                productId: string;
                productName: string;
                unitPriceCents: number;
                quantity: number;
              }[];
            };
          };
        },
      ];
      expect(args.data.userId).toBe('user-1');
      // 2 × 1000 + 1 × 2500 — the snapshot's arithmetic, not the catalog's.
      expect(args.data.totalCents).toBe(4500);
      expect(args.data.shippingLine1).toBe(ADDRESS.line1);
      expect(args.data.items.create).toEqual([
        {
          productId: 'p1',
          productName: 'Camiseta',
          unitPriceCents: 1000,
          quantity: 2,
        },
        {
          productId: 'p2',
          productName: 'Caneca',
          unitPriceCents: 2500,
          quantity: 1,
        },
      ]);
    });

    it('decrements every item inside the transaction', async () => {
      const mocks = createMocks();
      primeHappyPath(mocks);

      await serviceWith(mocks).checkout('user-1', ADDRESS);

      expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mocks.stock.decrement).toHaveBeenCalledWith(
        'p1',
        2,
        expect.anything(),
      );
      expect(mocks.stock.decrement).toHaveBeenCalledWith(
        'p2',
        1,
        expect.anything(),
      );
    });

    it('registers the payment after the transaction and stores the reference', async () => {
      const mocks = createMocks();
      primeHappyPath(mocks);

      const order = await serviceWith(mocks).checkout('user-1', ADDRESS);

      expect(mocks.payments.createPayment).toHaveBeenCalledWith({
        orderId: 'order-1',
        amountCents: 4500,
      });
      const [updateArgs] = mocks.prisma.order.update.mock.calls[0] as [
        { where: { id: string }; data: { paymentRef: string } },
      ];
      expect(updateArgs.where).toEqual({ id: 'order-1' });
      expect(updateArgs.data.paymentRef).toBe('fake_ref');
      expect(order.paymentRef).toBe('fake_ref');
    });

    it('409s on an empty or missing cart without opening a transaction', async () => {
      const mocks = createMocks();
      mocks.prisma.cart.findUnique.mockResolvedValue(null);

      await expect(
        serviceWith(mocks).checkout('user-1', ADDRESS),
      ).rejects.toThrow(ConflictException);

      mocks.prisma.cart.findUnique.mockResolvedValue(cartWith([]));
      await expect(
        serviceWith(mocks).checkout('user-1', ADDRESS),
      ).rejects.toThrow(ConflictException);

      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('409s naming the products that are no longer for sale, before any write', async () => {
      const mocks = createMocks();
      mocks.prisma.cart.findUnique.mockResolvedValue(
        cartWith([
          { productId: 'p1', quantity: 1 },
          { productId: 'p2', quantity: 1 },
        ]),
      );
      mocks.products.findByIds.mockResolvedValue([
        sellableProduct('p1', 1000),
        {
          ...sellableProduct('p2', 2500),
          status: ProductStatus.ARCHIVED,
        },
      ]);

      const attempt = serviceWith(mocks).checkout('user-1', ADDRESS);

      await expect(attempt).rejects.toThrow(ConflictException);
      await expect(attempt).rejects.toMatchObject({
        response: expect.objectContaining({ productIds: ['p2'] }) as unknown,
      });
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rolls back and 409s naming the items that lost the stock race', async () => {
      const mocks = createMocks();
      primeHappyPath(mocks);
      mocks.stock.decrement.mockResolvedValueOnce(true);
      mocks.stock.decrement.mockResolvedValueOnce(false);

      const attempt = serviceWith(mocks).checkout('user-1', ADDRESS);

      await expect(attempt).rejects.toThrow(ConflictException);
      await expect(attempt).rejects.toMatchObject({
        response: expect.objectContaining({ productIds: ['p2'] }) as unknown,
      });
      // The throw happens inside $transaction, so Prisma rolls everything
      // back; the order must never have been created.
      expect(mocks.prisma.order.create).not.toHaveBeenCalled();
      expect(mocks.payments.createPayment).not.toHaveBeenCalled();
    });

    it('409s when a concurrent checkout already consumed the cart', async () => {
      const mocks = createMocks();
      primeHappyPath(mocks);
      // Both requests read the same 2 items; the loser's delete finds 0 rows.
      mocks.prisma.cartItem.deleteMany.mockResolvedValue({ count: 0 });

      await expect(
        serviceWith(mocks).checkout('user-1', ADDRESS),
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
              productName: 'Camiseta',
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
      expect(mocks.stock.restock).toHaveBeenCalledWith(
        'p1',
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
  });
});
