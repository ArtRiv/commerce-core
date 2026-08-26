import { NotFoundException } from '@nestjs/common';

import { ProductStatus } from '../generated/prisma/enums';
import type { PrismaService } from '../prisma/prisma.service';
import { StockService } from './stock.service';

function createPrismaMock() {
  return {
    productVariant: {
      findUnique: jest.fn<Promise<{ id: string } | null>, [unknown]>(),
      update: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({
        id: 'variant-1',
        label: 'M',
        position: 1,
        stockQuantity: 12,
      }),
      updateMany: jest.fn<Promise<{ count: number }>, [unknown]>(),
    },
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

function serviceWith(prisma: PrismaMock): StockService {
  return new StockService(prisma as unknown as PrismaService);
}

describe('StockService', () => {
  describe('setQuantity', () => {
    it('sets the absolute quantity on the variant', async () => {
      const prisma = createPrismaMock();
      prisma.productVariant.findUnique.mockResolvedValue({ id: 'variant-1' });

      const result = await serviceWith(prisma).setQuantity('variant-1', 12);

      expect(result).toEqual({
        id: 'variant-1',
        label: 'M',
        position: 1,
        stockQuantity: 12,
      });
      const [args] = prisma.productVariant.update.mock.calls[0] as [
        { where: { id: string }; data: { stockQuantity: number } },
      ];
      expect(args.where).toEqual({ id: 'variant-1' });
      expect(args.data).toEqual({ stockQuantity: 12 });
    });

    it('404s on a variant that does not exist', async () => {
      const prisma = createPrismaMock();
      prisma.productVariant.findUnique.mockResolvedValue(null);

      await expect(serviceWith(prisma).setQuantity('ghost', 5)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.productVariant.update).not.toHaveBeenCalled();
    });
  });

  describe('decrement', () => {
    it('decrements the VARIANT behind a conditional WHERE', async () => {
      const prisma = createPrismaMock();
      prisma.productVariant.updateMany.mockResolvedValue({ count: 1 });

      const ok = await serviceWith(prisma).decrement('variant-1', 2);

      expect(ok).toBe(true);
      // The whole point of the design: quantity check and decrement are ONE
      // statement, so the race for the last unit of a SIZE is settled by
      // Postgres. The status filter reaches through to the owning product,
      // which is where the lifecycle lives — variants have no status.
      const [args] = prisma.productVariant.updateMany.mock.calls[0] as [
        {
          where: {
            id: string;
            stockQuantity: { gte: number };
            product: { status: ProductStatus };
          };
          data: { stockQuantity: { decrement: number } };
        },
      ];
      expect(args.where).toEqual({
        id: 'variant-1',
        stockQuantity: { gte: 2 },
        product: { status: ProductStatus.ACTIVE },
      });
      expect(args.data).toEqual({ stockQuantity: { decrement: 2 } });
    });

    it('reports failure when no row matched, without a second write', async () => {
      const prisma = createPrismaMock();
      prisma.productVariant.updateMany.mockResolvedValue({ count: 0 });

      // Insufficient stock, archived product and missing variant all land
      // here; callers only need to know the sale cannot proceed.
      const ok = await serviceWith(prisma).decrement('variant-1', 99);

      expect(ok).toBe(false);
      expect(prisma.productVariant.update).not.toHaveBeenCalled();
    });

    it.each([0, -1, 1.5])(
      'refuses quantity %p without touching the database',
      async (quantity) => {
        const prisma = createPrismaMock();

        await expect(
          serviceWith(prisma).decrement('variant-1', quantity),
        ).rejects.toThrow();
        expect(prisma.productVariant.updateMany).not.toHaveBeenCalled();
      },
    );

    it('runs against the given transaction client, not the service client', async () => {
      const prisma = createPrismaMock();
      const tx = createPrismaMock();
      tx.productVariant.updateMany.mockResolvedValue({ count: 1 });

      // Checkout's atomicity hinges on this: order creation and every
      // decrement must share one transaction, so the caller lends its client.
      const ok = await serviceWith(prisma).decrement(
        'variant-1',
        2,
        tx as unknown as Parameters<StockService['decrement']>[2],
      );

      expect(ok).toBe(true);
      expect(tx.productVariant.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.productVariant.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('restock', () => {
    it('increments unconditionally — archived products take returns too', async () => {
      const prisma = createPrismaMock();
      prisma.productVariant.updateMany.mockResolvedValue({ count: 1 });

      await serviceWith(prisma).restock('variant-1', 3);

      const [args] = prisma.productVariant.updateMany.mock.calls[0] as [
        {
          where: Record<string, unknown>;
          data: { stockQuantity: { increment: number } };
        },
      ];
      // No status filter: cancelled units physically return to the shelf even
      // when the product has since been archived — the product just stays out
      // of the storefront and keeps refusing new sales.
      expect(args.where).toEqual({ id: 'variant-1' });
      expect(args.data).toEqual({ stockQuantity: { increment: 3 } });
    });

    it('throws when the variant row is missing', async () => {
      const prisma = createPrismaMock();
      prisma.productVariant.updateMany.mockResolvedValue({ count: 0 });

      // Unreachable from cancellation (order_items Restrict variant deletion),
      // so a miss here is a caller bug worth crashing on, not a false return.
      await expect(serviceWith(prisma).restock('ghost', 3)).rejects.toThrow();
    });

    it.each([0, -1, 1.5])(
      'refuses quantity %p without touching the database',
      async (quantity) => {
        const prisma = createPrismaMock();

        await expect(
          serviceWith(prisma).restock('variant-1', quantity),
        ).rejects.toThrow();
        expect(prisma.productVariant.updateMany).not.toHaveBeenCalled();
      },
    );

    it('runs against the given transaction client, not the service client', async () => {
      const prisma = createPrismaMock();
      const tx = createPrismaMock();
      tx.productVariant.updateMany.mockResolvedValue({ count: 1 });

      await serviceWith(prisma).restock(
        'variant-1',
        3,
        tx as unknown as Parameters<StockService['restock']>[2],
      );

      expect(tx.productVariant.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.productVariant.updateMany).not.toHaveBeenCalled();
    });
  });
});
