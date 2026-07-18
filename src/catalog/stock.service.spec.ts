import { NotFoundException } from '@nestjs/common';

import { ProductStatus } from '../generated/prisma/enums';
import type { PrismaService } from '../prisma/prisma.service';
import { StockService } from './stock.service';

function createPrismaMock() {
  return {
    product: {
      findUnique: jest.fn<Promise<{ id: string } | null>, [unknown]>(),
      update: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({
        id: 'product-1',
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
    it('sets the absolute quantity on the product', async () => {
      const prisma = createPrismaMock();
      prisma.product.findUnique.mockResolvedValue({ id: 'product-1' });

      const result = await serviceWith(prisma).setQuantity('product-1', 12);

      expect(result).toEqual({ id: 'product-1', stockQuantity: 12 });
      const [args] = prisma.product.update.mock.calls[0] as [
        { where: { id: string }; data: { stockQuantity: number } },
      ];
      expect(args.where).toEqual({ id: 'product-1' });
      expect(args.data).toEqual({ stockQuantity: 12 });
    });

    it('404s on a product that does not exist', async () => {
      const prisma = createPrismaMock();
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(serviceWith(prisma).setQuantity('ghost', 5)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.product.update).not.toHaveBeenCalled();
    });
  });

  describe('decrement', () => {
    it('decrements behind a conditional WHERE and reports success', async () => {
      const prisma = createPrismaMock();
      prisma.product.updateMany.mockResolvedValue({ count: 1 });

      const ok = await serviceWith(prisma).decrement('product-1', 2);

      expect(ok).toBe(true);
      // The whole point of the design: quantity check and decrement are ONE
      // statement, so the race for the last unit is settled by Postgres.
      const [args] = prisma.product.updateMany.mock.calls[0] as [
        {
          where: {
            id: string;
            status: ProductStatus;
            stockQuantity: { gte: number };
          };
          data: { stockQuantity: { decrement: number } };
        },
      ];
      expect(args.where).toEqual({
        id: 'product-1',
        status: ProductStatus.ACTIVE,
        stockQuantity: { gte: 2 },
      });
      expect(args.data).toEqual({ stockQuantity: { decrement: 2 } });
    });

    it('reports failure when no row matched, without a second write', async () => {
      const prisma = createPrismaMock();
      prisma.product.updateMany.mockResolvedValue({ count: 0 });

      // Insufficient stock, archived product and missing product all land
      // here; callers only need to know the sale cannot proceed.
      const ok = await serviceWith(prisma).decrement('product-1', 99);

      expect(ok).toBe(false);
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it.each([0, -1, 1.5])(
      'refuses quantity %p without touching the database',
      async (quantity) => {
        const prisma = createPrismaMock();

        await expect(
          serviceWith(prisma).decrement('product-1', quantity),
        ).rejects.toThrow();
        expect(prisma.product.updateMany).not.toHaveBeenCalled();
      },
    );

    it('runs against the given transaction client, not the service client', async () => {
      const prisma = createPrismaMock();
      const tx = createPrismaMock();
      tx.product.updateMany.mockResolvedValue({ count: 1 });

      // Checkout's atomicity hinges on this: order creation and every
      // decrement must share one transaction, so the caller lends its client.
      const ok = await serviceWith(prisma).decrement(
        'product-1',
        2,
        tx as unknown as Parameters<StockService['decrement']>[2],
      );

      expect(ok).toBe(true);
      expect(tx.product.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.product.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('restock', () => {
    it('increments unconditionally — archived products take returns too', async () => {
      const prisma = createPrismaMock();
      prisma.product.updateMany.mockResolvedValue({ count: 1 });

      await serviceWith(prisma).restock('product-1', 3);

      const [args] = prisma.product.updateMany.mock.calls[0] as [
        {
          where: Record<string, unknown>;
          data: { stockQuantity: { increment: number } };
        },
      ];
      // No status filter: cancelled units physically return to the shelf even
      // when the product has since been archived — the product just stays out
      // of the storefront and keeps refusing new sales.
      expect(args.where).toEqual({ id: 'product-1' });
      expect(args.data).toEqual({ stockQuantity: { increment: 3 } });
    });

    it('throws when the product row is missing', async () => {
      const prisma = createPrismaMock();
      prisma.product.updateMany.mockResolvedValue({ count: 0 });

      // Unreachable from cancellation (order_items Restrict product deletion),
      // so a miss here is a caller bug worth crashing on, not a false return.
      await expect(serviceWith(prisma).restock('ghost', 3)).rejects.toThrow();
    });

    it.each([0, -1, 1.5])(
      'refuses quantity %p without touching the database',
      async (quantity) => {
        const prisma = createPrismaMock();

        await expect(
          serviceWith(prisma).restock('product-1', quantity),
        ).rejects.toThrow();
        expect(prisma.product.updateMany).not.toHaveBeenCalled();
      },
    );

    it('runs against the given transaction client, not the service client', async () => {
      const prisma = createPrismaMock();
      const tx = createPrismaMock();
      tx.product.updateMany.mockResolvedValue({ count: 1 });

      await serviceWith(prisma).restock(
        'product-1',
        3,
        tx as unknown as Parameters<StockService['restock']>[2],
      );

      expect(tx.product.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.product.updateMany).not.toHaveBeenCalled();
    });
  });
});
