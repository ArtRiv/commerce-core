import { ConflictException, NotFoundException } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';
import { CategoriesService } from './categories.service';

interface CategoryRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
}

function categoryRow(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id: 'category-1',
    name: 'Camisetas',
    slug: 'camisetas',
    description: null,
    ...overrides,
  };
}

function createPrismaMock() {
  return {
    category: {
      findUnique: jest.fn<Promise<CategoryRow | null>, [unknown]>(),
      findMany: jest
        .fn<Promise<Pick<CategoryRow, 'slug'>[] | CategoryRow[]>, [unknown]>()
        .mockResolvedValue([]),
      create: jest
        .fn<Promise<CategoryRow>, [unknown]>()
        .mockResolvedValue(categoryRow()),
      update: jest
        .fn<Promise<CategoryRow>, [unknown]>()
        .mockResolvedValue(categoryRow()),
      delete: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({}),
    },
  };
}

/** What Prisma returns once ACTIVE_PRODUCT_COUNT is included. */
function countedRow(
  overrides: Partial<CategoryRow> = {},
  products = 0,
): CategoryRow & { _count: { products: number } } {
  return { ...categoryRow(overrides), _count: { products } };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

function serviceWith(prisma: PrismaMock): CategoriesService {
  return new CategoriesService(prisma as unknown as PrismaService);
}

describe('CategoriesService', () => {
  describe('create', () => {
    it('generates the slug from the name when none is sent', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).create({ name: 'Moda Íntima' });

      const [args] = prisma.category.create.mock.calls[0] as [
        { data: { name: string; slug: string } },
      ];
      expect(args.data.slug).toBe('moda-intima');
    });

    it('suffixes an auto-generated slug that collides', async () => {
      const prisma = createPrismaMock();
      prisma.category.findMany.mockResolvedValue([{ slug: 'camisetas' }]);

      await serviceWith(prisma).create({ name: 'Camisetas' });

      const [args] = prisma.category.create.mock.calls[0] as [
        { data: { slug: string } },
      ];
      expect(args.data.slug).toBe('camisetas-2');
    });

    it('409s an explicit slug that is already taken', async () => {
      const prisma = createPrismaMock();
      prisma.category.findUnique.mockResolvedValue(categoryRow());

      // Explicit choice colliding is an error, never silently suffixed: the
      // caller asked for THAT slug, and getting a different one back would be
      // a lie about what was created.
      await expect(
        serviceWith(prisma).create({ name: 'Novas', slug: 'camisetas' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.category.create).not.toHaveBeenCalled();
    });

    it('uses an explicit free slug verbatim, skipping auto-suffix logic', async () => {
      const prisma = createPrismaMock();
      prisma.category.findUnique.mockResolvedValue(null);

      await serviceWith(prisma).create({ name: 'Novas', slug: 'promo' });

      const [args] = prisma.category.create.mock.calls[0] as [
        { data: { slug: string } },
      ];
      expect(args.data.slug).toBe('promo');
      expect(prisma.category.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findBySlug', () => {
    it('carries productCount too', async () => {
      const prisma = createPrismaMock();
      prisma.category.findUnique.mockResolvedValue(
        countedRow({ slug: 'camisetas' }, 3),
      );

      const category = await serviceWith(prisma).findBySlug('camisetas');

      expect(category).toMatchObject({ slug: 'camisetas', productCount: 3 });
      expect(category).not.toHaveProperty('_count');
    });

    it('404s when the slug matches nothing', async () => {
      const prisma = createPrismaMock();
      prisma.category.findUnique.mockResolvedValue(null);

      await expect(serviceWith(prisma).findBySlug('ghost')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('404s a category that does not exist', async () => {
      const prisma = createPrismaMock();
      prisma.category.findUnique.mockResolvedValue(null);

      await expect(
        serviceWith(prisma).update('ghost', { name: 'X' }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.category.update).not.toHaveBeenCalled();
    });

    it('409s a slug change that collides with another category', async () => {
      const prisma = createPrismaMock();
      prisma.category.findUnique
        .mockResolvedValueOnce(categoryRow()) // the one being updated
        .mockResolvedValueOnce(
          categoryRow({ id: 'category-2', slug: 'promo' }),
        );

      await expect(
        serviceWith(prisma).update('category-1', { slug: 'promo' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.category.update).not.toHaveBeenCalled();
    });

    it('accepts re-sending the category’s own slug', async () => {
      const prisma = createPrismaMock();
      prisma.category.findUnique
        .mockResolvedValueOnce(categoryRow())
        // The slug lookup finds the category itself — that is not a conflict.
        .mockResolvedValueOnce(categoryRow());

      await serviceWith(prisma).update('category-1', { slug: 'camisetas' });

      expect(prisma.category.update).toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('counts only ACTIVE products', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).findAll();

      const [args] = prisma.category.findMany.mock.calls[0] as [
        { include?: { _count?: { select?: { products?: unknown } } } },
      ];
      // A rail reading "Camisetas (5)" over a grid of three is worse than no
      // number, so the count has to match what the storefront actually shows.
      expect(args.include?._count?.select?.products).toEqual({
        where: { product: { status: 'ACTIVE' } },
      });
    });

    it('flattens the count into productCount', async () => {
      const prisma = createPrismaMock();
      prisma.category.findMany.mockResolvedValue([
        countedRow({ slug: 'camisetas' }, 5),
      ] as never);

      const [category] = await serviceWith(prisma).findAll();

      expect(category).toMatchObject({ slug: 'camisetas', productCount: 5 });
      expect(category).not.toHaveProperty('_count');
    });

    it('reports an empty category as zero, not as a missing field', async () => {
      const prisma = createPrismaMock();
      prisma.category.findMany.mockResolvedValue([countedRow({}, 0)] as never);

      const [category] = await serviceWith(prisma).findAll();

      expect(category.productCount).toBe(0);
    });

    it('sorts categories by name', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).findAll();

      const [args] = prisma.category.findMany.mock.calls[0] as [
        { orderBy?: unknown },
      ];
      expect(args.orderBy).toEqual({ name: 'asc' });
    });
  });

  describe('remove', () => {
    it('hard-deletes an existing category', async () => {
      const prisma = createPrismaMock();
      prisma.category.findUnique.mockResolvedValue(categoryRow());

      await serviceWith(prisma).remove('category-1');

      const [args] = prisma.category.delete.mock.calls[0] as [
        { where: { id: string } },
      ];
      expect(args.where).toEqual({ id: 'category-1' });
    });

    it('404s when there is nothing to delete', async () => {
      const prisma = createPrismaMock();
      prisma.category.findUnique.mockResolvedValue(null);

      await expect(serviceWith(prisma).remove('ghost')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.category.delete).not.toHaveBeenCalled();
    });
  });
});
