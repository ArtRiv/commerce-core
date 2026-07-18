import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { ProductStatus } from '../generated/prisma/enums';
import type { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from './products.service';

interface CategoryRef {
  id: string;
  name: string;
  slug: string;
}

interface ProductRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  priceCents: number;
  imageUrls: string[];
  status: ProductStatus;
  stockQuantity: number;
  categories: { category: CategoryRef }[];
}

function productRow(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: 'product-1',
    name: 'Camiseta Azul',
    slug: 'camiseta-azul',
    description: null,
    priceCents: 4990,
    imageUrls: [],
    status: ProductStatus.ACTIVE,
    stockQuantity: 10,
    categories: [],
    ...overrides,
  };
}

function createPrismaMock() {
  const client = {
    product: {
      findUnique: jest.fn<Promise<ProductRow | null>, [unknown]>(),
      findFirst: jest.fn<Promise<ProductRow | null>, [unknown]>(),
      findMany: jest.fn<Promise<unknown[]>, [unknown]>().mockResolvedValue([]),
      count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
      create: jest
        .fn<Promise<ProductRow>, [unknown]>()
        .mockResolvedValue(productRow()),
      update: jest
        .fn<Promise<ProductRow>, [unknown]>()
        .mockResolvedValue(productRow()),
    },
    category: {
      count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  return client;
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

function serviceWith(prisma: PrismaMock): ProductsService {
  return new ProductsService(prisma as unknown as PrismaService);
}

const baseInput = { name: 'Camiseta Azul', priceCents: 4990 };

describe('ProductsService', () => {
  describe('create', () => {
    it('generates the slug from the name when none is sent', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).create(baseInput);

      const [args] = prisma.product.create.mock.calls[0] as [
        { data: { slug: string } },
      ];
      expect(args.data.slug).toBe('camiseta-azul');
    });

    it('suffixes an auto-generated slug that collides', async () => {
      const prisma = createPrismaMock();
      prisma.product.findMany.mockResolvedValue([{ slug: 'camiseta-azul' }]);

      await serviceWith(prisma).create(baseInput);

      const [args] = prisma.product.create.mock.calls[0] as [
        { data: { slug: string } },
      ];
      expect(args.data.slug).toBe('camiseta-azul-2');
    });

    it('409s an explicit slug that is already taken', async () => {
      const prisma = createPrismaMock();
      prisma.product.findUnique.mockResolvedValue(productRow());

      await expect(
        serviceWith(prisma).create({ ...baseInput, slug: 'camiseta-azul' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it('400s a categoryId that does not exist', async () => {
      const prisma = createPrismaMock();
      // Two ids sent, only one row matches: at least one id is bogus. A FK
      // violation would catch this too, but as an opaque 500 — the caller
      // deserves to know their input was wrong.
      prisma.category.count.mockResolvedValue(1);

      await expect(
        serviceWith(prisma).create({
          ...baseInput,
          categoryIds: ['real', 'ghost'],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it('connects categories through the join table and flattens them back', async () => {
      const prisma = createPrismaMock();
      prisma.category.count.mockResolvedValue(1);
      prisma.product.create.mockResolvedValue(
        productRow({
          categories: [
            { category: { id: 'cat-1', name: 'Camisetas', slug: 'camisetas' } },
          ],
        }),
      );

      const result = await serviceWith(prisma).create({
        ...baseInput,
        categoryIds: ['cat-1'],
      });

      const [args] = prisma.product.create.mock.calls[0] as [
        { data: { categories: { create: { categoryId: string }[] } } },
      ];
      expect(args.data.categories).toEqual({
        create: [{ categoryId: 'cat-1' }],
      });
      // Callers see plain categories, not join-table rows.
      expect(result.categories).toEqual([
        { id: 'cat-1', name: 'Camisetas', slug: 'camisetas' },
      ]);
    });
  });

  describe('findMany', () => {
    it('shows the public only ACTIVE products', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).findMany({});

      const [args] = prisma.product.findMany.mock.calls[0] as [
        { where: { status?: ProductStatus } },
      ];
      expect(args.where.status).toBe(ProductStatus.ACTIVE);
    });

    it('drops the status filter for "all"', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).findMany({ status: 'all' });

      const [args] = prisma.product.findMany.mock.calls[0] as [
        { where: { status?: ProductStatus } },
      ];
      expect(args.where.status).toBeUndefined();
    });

    it('passes a specific status through', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).findMany({ status: ProductStatus.DRAFT });

      const [args] = prisma.product.findMany.mock.calls[0] as [
        { where: { status?: ProductStatus } },
      ];
      expect(args.where.status).toBe(ProductStatus.DRAFT);
    });

    it('filters by category slug through the join table', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).findMany({ category: 'camisetas' });

      const [args] = prisma.product.findMany.mock.calls[0] as [
        { where: { categories?: unknown } },
      ];
      expect(args.where.categories).toEqual({
        some: { category: { slug: 'camisetas' } },
      });
    });

    it('searches by name, case-insensitively', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).findMany({ search: 'azul' });

      const [args] = prisma.product.findMany.mock.calls[0] as [
        { where: { name?: unknown } },
      ];
      expect(args.where.name).toEqual({
        contains: 'azul',
        mode: 'insensitive',
      });
    });

    it('paginates with skip/take and clamps perPage at 100', async () => {
      const prisma = createPrismaMock();

      const result = await serviceWith(prisma).findMany({
        page: 3,
        perPage: 500,
      });

      const [args] = prisma.product.findMany.mock.calls[0] as [
        { skip: number; take: number },
      ];
      // Clamped rather than rejected (docs/specs/catalog.md): a storefront
      // asking for too much gets the maximum, not an error.
      expect(args.take).toBe(100);
      expect(args.skip).toBe(200);
      expect(result.page).toBe(3);
      expect(result.perPage).toBe(100);
    });

    it('returns items and the total count together', async () => {
      const prisma = createPrismaMock();
      prisma.product.findMany.mockResolvedValue([productRow()]);
      prisma.product.count.mockResolvedValue(42);

      const result = await serviceWith(prisma).findMany({});

      expect(result.total).toBe(42);
      expect(result.items).toHaveLength(1);
    });
  });

  describe('findOne', () => {
    it('looks the product up by id or slug', async () => {
      const prisma = createPrismaMock();
      prisma.product.findFirst.mockResolvedValue(productRow());

      await serviceWith(prisma).findOne('camiseta-azul', {
        includeNonActive: false,
      });

      const [args] = prisma.product.findFirst.mock.calls[0] as [
        { where: { OR: unknown[] } },
      ];
      expect(args.where.OR).toEqual([
        { id: 'camiseta-azul' },
        { slug: 'camiseta-azul' },
      ]);
    });

    it('404s when nothing matches', async () => {
      const prisma = createPrismaMock();
      prisma.product.findFirst.mockResolvedValue(null);

      await expect(
        serviceWith(prisma).findOne('ghost', { includeNonActive: false }),
      ).rejects.toThrow(NotFoundException);
    });

    it('hides a non-ACTIVE product from the public as a 404, not a 403', async () => {
      const prisma = createPrismaMock();
      prisma.product.findFirst.mockResolvedValue(
        productRow({ status: ProductStatus.DRAFT }),
      );

      // 404 on purpose: a 403 would confirm to anyone probing slugs that an
      // unreleased product exists. Not found and not visible look identical.
      await expect(
        serviceWith(prisma).findOne('camiseta-azul', {
          includeNonActive: false,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('shows a non-ACTIVE product to a viewer with read access', async () => {
      const prisma = createPrismaMock();
      prisma.product.findFirst.mockResolvedValue(
        productRow({ status: ProductStatus.ARCHIVED }),
      );

      const result = await serviceWith(prisma).findOne('camiseta-azul', {
        includeNonActive: true,
      });

      expect(result.status).toBe(ProductStatus.ARCHIVED);
    });
  });

  describe('update', () => {
    it('404s a product that does not exist', async () => {
      const prisma = createPrismaMock();
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(
        serviceWith(prisma).update('ghost', { name: 'X' }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it('409s a slug change that collides with another product', async () => {
      const prisma = createPrismaMock();
      prisma.product.findUnique
        .mockResolvedValueOnce(productRow())
        .mockResolvedValueOnce(productRow({ id: 'product-2', slug: 'tomado' }));

      await expect(
        serviceWith(prisma).update('product-1', { slug: 'tomado' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it('replaces the whole category set when categoryIds is sent', async () => {
      const prisma = createPrismaMock();
      prisma.product.findUnique.mockResolvedValue(productRow());
      prisma.category.count.mockResolvedValue(1);

      await serviceWith(prisma).update('product-1', {
        categoryIds: ['cat-9'],
      });

      const [args] = prisma.product.update.mock.calls[0] as [
        { data: { categories?: unknown } },
      ];
      // deleteMany-then-create inside the same nested write: the sent list IS
      // the new truth, whatever was attached before.
      expect(args.data.categories).toEqual({
        deleteMany: {},
        create: [{ categoryId: 'cat-9' }],
      });
    });

    it('leaves categories untouched when categoryIds is absent', async () => {
      const prisma = createPrismaMock();
      prisma.product.findUnique.mockResolvedValue(productRow());

      await serviceWith(prisma).update('product-1', { name: 'Novo Nome' });

      const [args] = prisma.product.update.mock.calls[0] as [
        { data: { categories?: unknown } },
      ];
      expect(args.data.categories).toBeUndefined();
    });
  });

  describe('archive', () => {
    it('archives instead of deleting', async () => {
      const prisma = createPrismaMock();
      prisma.product.findUnique.mockResolvedValue(productRow());

      await serviceWith(prisma).archive('product-1');

      const [args] = prisma.product.update.mock.calls[0] as [
        { where: { id: string }; data: { status: ProductStatus } },
      ];
      expect(args.where).toEqual({ id: 'product-1' });
      expect(args.data.status).toBe(ProductStatus.ARCHIVED);
    });

    it('404s when there is nothing to archive', async () => {
      const prisma = createPrismaMock();
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(serviceWith(prisma).archive('ghost')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.product.update).not.toHaveBeenCalled();
    });
  });
});
