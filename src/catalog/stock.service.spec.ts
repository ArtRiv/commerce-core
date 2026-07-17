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
  });
});
