import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { ProductsService } from '../catalog/products.service';
import { ProductStatus } from '../generated/prisma/enums';
import type { PrismaService } from '../prisma/prisma.service';
import { CartService } from './cart.service';

interface SellableProduct {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  status: ProductStatus;
  stockQuantity: number;
}

function sellable(overrides: Partial<SellableProduct> = {}): SellableProduct {
  return {
    id: 'product-1',
    name: 'Camiseta Azul',
    slug: 'camiseta-azul',
    priceCents: 4990,
    status: ProductStatus.ACTIVE,
    stockQuantity: 10,
    ...overrides,
  };
}

interface CartRow {
  id: string;
  userId: string;
  items: { productId: string; quantity: number }[];
}

function createPrismaMock() {
  return {
    cart: {
      findUnique: jest.fn<Promise<CartRow | null>, [unknown]>(),
      upsert: jest
        .fn<Promise<{ id: string }>, [unknown]>()
        .mockResolvedValue({ id: 'cart-1' }),
    },
    cartItem: {
      upsert: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({}),
      updateMany: jest.fn<Promise<{ count: number }>, [unknown]>(),
      deleteMany: jest
        .fn<Promise<{ count: number }>, [unknown]>()
        .mockResolvedValue({ count: 0 }),
    },
  };
}

function createProductsMock() {
  return {
    findByIds: jest
      .fn<Promise<SellableProduct[]>, [string[]]>()
      .mockResolvedValue([]),
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;
type ProductsMock = ReturnType<typeof createProductsMock>;

function serviceWith(prisma: PrismaMock, products: ProductsMock): CartService {
  return new CartService(
    prisma as unknown as PrismaService,
    products as unknown as ProductsService,
  );
}

describe('CartService', () => {
  describe('getCart', () => {
    it('returns an empty cart for a user who never added anything', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();
      prisma.cart.findUnique.mockResolvedValue(null);

      const cart = await serviceWith(prisma, products).getCart('user-1');

      // Zero, not null and not absent: a badge that has to handle undefined
      // is a badly written contract (docs/specs/cart-totals.md).
      expect(cart).toEqual({ items: [], itemsSubtotalCents: 0, itemCount: 0 });
      expect(products.findByIds).not.toHaveBeenCalled();
    });

    it('joins items with live catalog data through the exported contract', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();
      prisma.cart.findUnique.mockResolvedValue({
        id: 'cart-1',
        userId: 'user-1',
        items: [{ productId: 'product-1', quantity: 2 }],
      });
      const live = sellable({ priceCents: 5990 });
      products.findByIds.mockResolvedValue([live]);

      const cart = await serviceWith(prisma, products).getCart('user-1');

      // Live price, not a snapshot: the cart never freezes money, checkout
      // does. Callers see today's catalog, whatever it says.
      expect(cart.items).toEqual([
        { productId: 'product-1', quantity: 2, product: live },
      ]);
      expect(products.findByIds).toHaveBeenCalledWith(['product-1']);
    });

    it('totals the lines server-side, in pieces and in cents', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();
      prisma.cart.findUnique.mockResolvedValue({
        id: 'cart-1',
        userId: 'user-1',
        items: [
          { productId: 'product-1', quantity: 2 },
          { productId: 'product-2', quantity: 1 },
        ],
      });
      products.findByIds.mockResolvedValue([
        sellable({ id: 'product-1', priceCents: 4990 }),
        sellable({ id: 'product-2', priceCents: 2500 }),
      ]);

      const cart = await serviceWith(prisma, products).getCart('user-1');

      expect(cart.itemsSubtotalCents).toBe(12_480);
      // Pieces, not lines: three garments in two lines is 3 on the badge.
      expect(cart.itemCount).toBe(3);
    });

    it('follows the live price when the catalog moves under the cart', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();
      prisma.cart.findUnique.mockResolvedValue({
        id: 'cart-1',
        userId: 'user-1',
        items: [{ productId: 'product-1', quantity: 2 }],
      });
      // The line was added at 4990; the back office has since repriced it.
      products.findByIds.mockResolvedValue([sellable({ priceCents: 5990 })]);

      const cart = await serviceWith(prisma, products).getCart('user-1');

      // The cart holds no money — it reports what the catalog says now,
      // which is what checkout will freeze and charge.
      expect(cart.itemsSubtotalCents).toBe(11_980);
    });
  });

  describe('addItem', () => {
    it('lazily creates the cart and upserts the item, incrementing on repeat', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();
      products.findByIds.mockResolvedValue([sellable()]);
      prisma.cart.findUnique.mockResolvedValue({
        id: 'cart-1',
        userId: 'user-1',
        items: [{ productId: 'product-1', quantity: 3 }],
      });

      await serviceWith(prisma, products).addItem('user-1', 'product-1', 3);

      const [upsertArgs] = prisma.cart.upsert.mock.calls[0] as [
        { where: { userId: string } },
      ];
      expect(upsertArgs.where).toEqual({ userId: 'user-1' });

      const [itemArgs] = prisma.cartItem.upsert.mock.calls[0] as [
        {
          where: unknown;
          create: { cartId: string; productId: string; quantity: number };
          update: { quantity: { increment: number } };
        },
      ];
      // Same product added twice sums quantities instead of duplicating the
      // line — resolved by the DB upsert, not a read-then-write.
      expect(itemArgs.create).toEqual({
        cartId: 'cart-1',
        productId: 'product-1',
        quantity: 3,
      });
      expect(itemArgs.update).toEqual({ quantity: { increment: 3 } });
    });

    it.each([ProductStatus.DRAFT, ProductStatus.ARCHIVED])(
      '404s on a %s product — the public cannot tell hidden from missing',
      async (status) => {
        const prisma = createPrismaMock();
        const products = createProductsMock();
        products.findByIds.mockResolvedValue([sellable({ status })]);

        await expect(
          serviceWith(prisma, products).addItem('user-1', 'product-1', 1),
        ).rejects.toThrow(NotFoundException);
        expect(prisma.cart.upsert).not.toHaveBeenCalled();
      },
    );

    it('404s on a product that does not exist at all', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();
      products.findByIds.mockResolvedValue([]);

      await expect(
        serviceWith(prisma, products).addItem('user-1', 'ghost', 1),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.cart.upsert).not.toHaveBeenCalled();
    });

    it('refuses a non-positive or fractional quantity before touching anything', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();

      await expect(
        serviceWith(prisma, products).addItem('user-1', 'product-1', 0),
      ).rejects.toThrow(BadRequestException);
      expect(products.findByIds).not.toHaveBeenCalled();
      expect(prisma.cart.upsert).not.toHaveBeenCalled();
    });
  });

  describe('setQuantity', () => {
    it('sets the absolute quantity on an existing item', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();
      prisma.cart.findUnique.mockResolvedValue({
        id: 'cart-1',
        userId: 'user-1',
        items: [{ productId: 'product-1', quantity: 5 }],
      });
      prisma.cartItem.updateMany.mockResolvedValue({ count: 1 });
      products.findByIds.mockResolvedValue([sellable()]);

      await serviceWith(prisma, products).setQuantity('user-1', 'product-1', 5);

      const [args] = prisma.cartItem.updateMany.mock.calls[0] as [
        {
          where: { cartId: string; productId: string };
          data: { quantity: number };
        },
      ];
      expect(args.where).toEqual({ cartId: 'cart-1', productId: 'product-1' });
      expect(args.data).toEqual({ quantity: 5 });
    });

    it('404s when the item is not in the cart', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();
      prisma.cart.findUnique.mockResolvedValue({
        id: 'cart-1',
        userId: 'user-1',
        items: [],
      });
      prisma.cartItem.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        serviceWith(prisma, products).setQuantity('user-1', 'ghost', 2),
      ).rejects.toThrow(NotFoundException);
    });

    it('404s when the user has no cart at all', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();
      prisma.cart.findUnique.mockResolvedValue(null);

      await expect(
        serviceWith(prisma, products).setQuantity('user-1', 'product-1', 2),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.cartItem.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('removeItem', () => {
    it('removes the item and 404s when it was never there', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();
      prisma.cart.findUnique.mockResolvedValue({
        id: 'cart-1',
        userId: 'user-1',
        items: [],
      });
      prisma.cartItem.deleteMany.mockResolvedValueOnce({ count: 1 });

      await serviceWith(prisma, products).removeItem('user-1', 'product-1');
      const [args] = prisma.cartItem.deleteMany.mock.calls[0] as [
        { where: { cartId: string; productId: string } },
      ];
      expect(args.where).toEqual({ cartId: 'cart-1', productId: 'product-1' });

      prisma.cartItem.deleteMany.mockResolvedValueOnce({ count: 0 });
      await expect(
        serviceWith(prisma, products).removeItem('user-1', 'ghost'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('clear', () => {
    it('empties the cart and is a no-op without one', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();
      prisma.cart.findUnique.mockResolvedValue({
        id: 'cart-1',
        userId: 'user-1',
        items: [],
      });

      const cleared = await serviceWith(prisma, products).clear('user-1');
      expect(cleared).toEqual({
        items: [],
        itemsSubtotalCents: 0,
        itemCount: 0,
      });
      const [args] = prisma.cartItem.deleteMany.mock.calls[0] as [
        { where: { cartId: string } },
      ];
      expect(args.where).toEqual({ cartId: 'cart-1' });

      prisma.cart.findUnique.mockResolvedValue(null);
      const empty = await serviceWith(prisma, products).clear('user-2');
      // Clearing a cart that never existed is success, not an error — the
      // caller asked for an empty cart and has one.
      expect(empty).toEqual({ items: [], itemsSubtotalCents: 0, itemCount: 0 });
    });
  });
});
