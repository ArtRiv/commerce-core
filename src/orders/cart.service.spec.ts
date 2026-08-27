import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { ProductsService } from '../catalog/products.service';
import { ProductStatus } from '../generated/prisma/enums';
import type { PrismaService } from '../prisma/prisma.service';
import { CartService } from './cart.service';

interface SellableVariant {
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
}

/** One size of one product, as the catalogue contract hands it over. */
function sellable(
  overrides: Partial<Omit<SellableVariant, 'product'>> = {},
  product: Partial<SellableVariant['product']> = {},
): SellableVariant {
  return {
    id: 'variant-m',
    label: 'M',
    position: 1,
    stockQuantity: 10,
    ...overrides,
    product: {
      id: 'product-1',
      name: 'Camiseta Azul',
      slug: 'camiseta-azul',
      priceCents: 4990,
      status: ProductStatus.ACTIVE,
      weightGrams: 220,
      ...product,
    },
  };
}

interface CartRow {
  id: string;
  userId: string;
  items: { variantId: string; quantity: number }[];
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
    findSellableByVariantIds: jest
      .fn<Promise<SellableVariant[]>, [string[]]>()
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
      expect(products.findSellableByVariantIds).not.toHaveBeenCalled();
    });

    it('joins lines with live catalog data through the exported contract', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();
      prisma.cart.findUnique.mockResolvedValue({
        id: 'cart-1',
        userId: 'user-1',
        items: [{ variantId: 'variant-m', quantity: 2 }],
      });
      const live = sellable({ stockQuantity: 3 }, { priceCents: 5990 });
      products.findSellableByVariantIds.mockResolvedValue([live]);

      const cart = await serviceWith(prisma, products).getCart('user-1');

      // Live price, not a snapshot: the cart never freezes money, checkout
      // does. Callers see today's catalog, whatever it says. The stock that
      // travels is the SIZE's, which is the only one that means anything on
      // a cart line.
      expect(cart.items).toEqual([
        {
          variantId: 'variant-m',
          quantity: 2,
          product: live.product,
          variant: {
            id: 'variant-m',
            label: 'M',
            position: 1,
            stockQuantity: 3,
          },
        },
      ]);
      expect(products.findSellableByVariantIds).toHaveBeenCalledWith([
        'variant-m',
      ]);
    });

    it('keeps two sizes of one product as two separate lines', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();
      prisma.cart.findUnique.mockResolvedValue({
        id: 'cart-1',
        userId: 'user-1',
        items: [
          { variantId: 'variant-p', quantity: 1 },
          { variantId: 'variant-m', quantity: 2 },
        ],
      });
      products.findSellableByVariantIds.mockResolvedValue([
        sellable({ id: 'variant-p', label: 'P', position: 0 }),
        sellable({ id: 'variant-m', label: 'M', position: 1 }),
      ]);

      const cart = await serviceWith(prisma, products).getCart('user-1');

      expect(cart.items.map((item) => item.variant.label)).toEqual(['P', 'M']);
      // Same product on both lines — that is the point, not a bug.
      expect(cart.items.every((item) => item.product.id === 'product-1')).toBe(
        true,
      );
    });

    it('totals the lines server-side, in pieces and in cents', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();
      prisma.cart.findUnique.mockResolvedValue({
        id: 'cart-1',
        userId: 'user-1',
        items: [
          { variantId: 'variant-m', quantity: 2 },
          { variantId: 'variant-u', quantity: 1 },
        ],
      });
      products.findSellableByVariantIds.mockResolvedValue([
        sellable({ id: 'variant-m' }, { priceCents: 4990 }),
        sellable(
          { id: 'variant-u', label: 'Único', position: 0 },
          { id: 'product-2', priceCents: 2500 },
        ),
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
        items: [{ variantId: 'variant-m', quantity: 2 }],
      });
      // The line was added at 4990; the back office has since repriced it.
      products.findSellableByVariantIds.mockResolvedValue([
        sellable({}, { priceCents: 5990 }),
      ]);

      const cart = await serviceWith(prisma, products).getCart('user-1');

      // The cart holds no money — it reports what the catalog says now,
      // which is what checkout will freeze and charge.
      expect(cart.itemsSubtotalCents).toBe(11_980);
    });
  });

  describe('addItem', () => {
    it('lazily creates the cart and upserts the line, incrementing on repeat', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();
      products.findSellableByVariantIds.mockResolvedValue([sellable()]);
      prisma.cart.findUnique.mockResolvedValue({
        id: 'cart-1',
        userId: 'user-1',
        items: [{ variantId: 'variant-m', quantity: 3 }],
      });

      await serviceWith(prisma, products).addItem('user-1', 'variant-m', 3);

      const [upsertArgs] = prisma.cart.upsert.mock.calls[0] as [
        { where: { userId: string } },
      ];
      expect(upsertArgs.where).toEqual({ userId: 'user-1' });

      const [itemArgs] = prisma.cartItem.upsert.mock.calls[0] as [
        {
          where: unknown;
          create: { cartId: string; variantId: string; quantity: number };
          update: { quantity: { increment: number } };
        },
      ];
      // The SAME size added twice sums quantities instead of duplicating the
      // line — resolved by the DB upsert, not a read-then-write. A different
      // size is a different line, by the cartId+variantId unique.
      expect(itemArgs.create).toEqual({
        cartId: 'cart-1',
        variantId: 'variant-m',
        quantity: 3,
      });
      expect(itemArgs.update).toEqual({ quantity: { increment: 3 } });
    });

    it.each([ProductStatus.DRAFT, ProductStatus.ARCHIVED])(
      '404s a variant of a %s product — the public cannot tell hidden from missing',
      async (status) => {
        const prisma = createPrismaMock();
        const products = createProductsMock();
        products.findSellableByVariantIds.mockResolvedValue([
          sellable({}, { status }),
        ]);

        await expect(
          serviceWith(prisma, products).addItem('user-1', 'variant-m', 1),
        ).rejects.toThrow(NotFoundException);
        expect(prisma.cart.upsert).not.toHaveBeenCalled();
      },
    );

    it('404s on a variant that does not exist at all', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();
      products.findSellableByVariantIds.mockResolvedValue([]);

      await expect(
        serviceWith(prisma, products).addItem('user-1', 'ghost', 1),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.cart.upsert).not.toHaveBeenCalled();
    });

    it('refuses a non-positive or fractional quantity before touching anything', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();

      await expect(
        serviceWith(prisma, products).addItem('user-1', 'variant-m', 0),
      ).rejects.toThrow(BadRequestException);
      expect(products.findSellableByVariantIds).not.toHaveBeenCalled();
      expect(prisma.cart.upsert).not.toHaveBeenCalled();
    });
  });

  describe('setQuantity', () => {
    it('sets the absolute quantity on an existing line', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();
      prisma.cart.findUnique.mockResolvedValue({
        id: 'cart-1',
        userId: 'user-1',
        items: [{ variantId: 'variant-m', quantity: 5 }],
      });
      prisma.cartItem.updateMany.mockResolvedValue({ count: 1 });
      products.findSellableByVariantIds.mockResolvedValue([sellable()]);

      await serviceWith(prisma, products).setQuantity('user-1', 'variant-m', 5);

      const [args] = prisma.cartItem.updateMany.mock.calls[0] as [
        {
          where: { cartId: string; variantId: string };
          data: { quantity: number };
        },
      ];
      expect(args.where).toEqual({ cartId: 'cart-1', variantId: 'variant-m' });
      expect(args.data).toEqual({ quantity: 5 });
    });

    it('404s when that size is not in the cart', async () => {
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
        serviceWith(prisma, products).setQuantity('user-1', 'variant-m', 2),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.cartItem.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('removeItem', () => {
    it('removes the line and 404s when it was never there', async () => {
      const prisma = createPrismaMock();
      const products = createProductsMock();
      prisma.cart.findUnique.mockResolvedValue({
        id: 'cart-1',
        userId: 'user-1',
        items: [],
      });
      prisma.cartItem.deleteMany.mockResolvedValueOnce({ count: 1 });

      await serviceWith(prisma, products).removeItem('user-1', 'variant-m');
      const [args] = prisma.cartItem.deleteMany.mock.calls[0] as [
        { where: { cartId: string; variantId: string } },
      ];
      expect(args.where).toEqual({ cartId: 'cart-1', variantId: 'variant-m' });

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
