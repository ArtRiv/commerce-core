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

interface VariantRow {
  id: string;
  label: string;
  position: number;
  stockQuantity: number;
}

interface ProductRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  priceCents: number;
  imageUrls: string[];
  status: ProductStatus;
  categories: { category: CategoryRef }[];
  variants: VariantRow[];
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
    categories: [],
    variants: [
      { id: 'variant-1', label: 'Único', position: 0, stockQuantity: 10 },
    ],
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
    productVariant: {
      findFirst: jest
        .fn<Promise<{ id: string } | null>, [unknown]>()
        .mockResolvedValue(null),
      findMany: jest.fn<Promise<unknown[]>, [unknown]>().mockResolvedValue([]),
      create: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({}),
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

    it('orders by newest, tiebroken on id, when no sort is asked for', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).findMany({});

      const [args] = prisma.product.findMany.mock.calls[0] as [
        { orderBy: unknown },
      ];
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
    });

    it.each([
      ['price_asc', { priceCents: 'asc' }],
      ['price_desc', { priceCents: 'desc' }],
      ['name_asc', { name: 'asc' }],
      ['newest', { createdAt: 'desc' }],
    ] as const)('orders by %s', async (sort, primary) => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).findMany({ sort });

      const [args] = prisma.product.findMany.mock.calls[0] as [
        { orderBy: unknown[] },
      ];
      // The id tiebreaker is what stops two equally-priced products from
      // swapping places between pages.
      expect(args.orderBy).toEqual([primary, { id: 'asc' }]);
    });

    it('leaves price unfiltered when neither bound is given', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).findMany({});

      const [args] = prisma.product.findMany.mock.calls[0] as [
        { where: { priceCents?: unknown } },
      ];
      expect(args.where.priceCents).toBeUndefined();
    });

    it('bounds price on the low side only', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).findMany({ minPriceCents: 15000 });

      const [args] = prisma.product.findMany.mock.calls[0] as [
        { where: { priceCents?: unknown } },
      ];
      expect(args.where.priceCents).toEqual({ gte: 15000, lte: undefined });
    });

    it('bounds price on the high side only', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).findMany({ maxPriceCents: 15000 });

      const [args] = prisma.product.findMany.mock.calls[0] as [
        { where: { priceCents?: unknown } },
      ];
      expect(args.where.priceCents).toEqual({ gte: undefined, lte: 15000 });
    });

    it('bounds price on both sides, inclusive', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).findMany({
        minPriceCents: 10000,
        maxPriceCents: 20000,
      });

      const [args] = prisma.product.findMany.mock.calls[0] as [
        { where: { priceCents?: unknown } },
      ];
      expect(args.where.priceCents).toEqual({ gte: 10000, lte: 20000 });
    });

    it('accepts an equal min and max, because the bounds are inclusive', async () => {
      const prisma = createPrismaMock();

      await expect(
        serviceWith(prisma).findMany({
          minPriceCents: 14990,
          maxPriceCents: 14990,
        }),
      ).resolves.toBeDefined();
    });

    it('rejects an impossible range instead of returning nothing', async () => {
      const prisma = createPrismaMock();

      // An empty list would read as "nothing matched" and hide the caller's bug.
      await expect(
        serviceWith(prisma).findMany({
          minPriceCents: 20000,
          maxPriceCents: 10000,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.product.findMany).not.toHaveBeenCalled();
    });

    it('applies the price bound to the count as well as the page', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).findMany({ minPriceCents: 15000 });

      const [countArgs] = prisma.product.count.mock.calls[0] as [
        { where: { priceCents?: unknown } },
      ];
      // total must describe the filtered catalogue, not the unfiltered one.
      expect(countArgs.where.priceCents).toEqual({
        gte: 15000,
        lte: undefined,
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

  describe('findSellableByVariantIds', () => {
    it('returns each variant with its product, any status', async () => {
      const prisma = createPrismaMock();
      const rows = [
        {
          id: 'variant-1',
          label: 'M',
          position: 1,
          stockQuantity: 4,
          product: {
            id: 'product-1',
            name: 'Camiseta Azul',
            slug: 'camiseta-azul',
            priceCents: 4990,
            status: ProductStatus.ACTIVE,
            weightGrams: 220,
          },
        },
        {
          id: 'variant-2',
          label: 'Único',
          position: 0,
          stockQuantity: 0,
          product: {
            id: 'product-2',
            name: 'Caneca',
            slug: 'caneca',
            priceCents: 2500,
            status: ProductStatus.ARCHIVED,
            weightGrams: null,
          },
        },
      ];
      prisma.productVariant.findMany.mockResolvedValue(rows);

      const result = await serviceWith(prisma).findSellableByVariantIds([
        'variant-1',
        'variant-2',
      ]);

      expect(result).toEqual(rows);
      const [args] = prisma.productVariant.findMany.mock.calls[0] as [
        { where: { id: { in: string[] } } },
      ];
      // No status filter: this read exists for cart views and checkout, and
      // both need to SEE a product that went non-ACTIVE to say so - hiding it
      // here would turn "this item left the catalog" into a silent absence.
      expect(args.where).toEqual({ id: { in: ['variant-1', 'variant-2'] } });
    });

    it('returns an empty list for an empty id list without querying', async () => {
      const prisma = createPrismaMock();

      const result = await serviceWith(prisma).findSellableByVariantIds([]);

      expect(result).toEqual([]);
      expect(prisma.productVariant.findMany).not.toHaveBeenCalled();
    });
  });

  describe('variants', () => {
    it('creates one Único variant when none is sent', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).create(baseInput);

      const [args] = prisma.product.create.mock.calls[0] as [
        {
          data: {
            variants: {
              create: {
                label: string;
                position: number;
                stockQuantity: number;
              }[];
            };
          };
        },
      ];
      // Never zero variants: a product with none is unbuyable, and "product
      // without variants" is the second code path this module must not have.
      expect(args.data.variants.create).toEqual([
        { label: 'Único', position: 0, stockQuantity: 0 },
      ]);
    });

    it('numbers positions by the order sent, so P/M/G/GG/XGG stays in order', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).create({
        ...baseInput,
        variants: [
          { label: 'P' },
          { label: 'M', stockQuantity: 4 },
          { label: 'G' },
          { label: 'GG' },
          { label: 'XGG' },
        ],
      });

      const [args] = prisma.product.create.mock.calls[0] as [
        {
          data: {
            variants: {
              create: {
                label: string;
                position: number;
                stockQuantity: number;
              }[];
            };
          };
        },
      ];
      // Alphabetically this list is G, GG, M, P, XGG - which is why position
      // exists and why it is never derived from the label.
      expect(args.data.variants.create).toEqual([
        { label: 'P', position: 0, stockQuantity: 0 },
        { label: 'M', position: 1, stockQuantity: 4 },
        { label: 'G', position: 2, stockQuantity: 0 },
        { label: 'GG', position: 3, stockQuantity: 0 },
        { label: 'XGG', position: 4, stockQuantity: 0 },
      ]);
    });

    it('400s two variants sharing a label', async () => {
      const prisma = createPrismaMock();

      await expect(
        serviceWith(prisma).create({
          ...baseInput,
          variants: [{ label: 'M' }, { label: 'M' }],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it('sums the variants into the product stockQuantity on read', async () => {
      const prisma = createPrismaMock();
      prisma.product.findFirst.mockResolvedValue(
        productRow({
          variants: [
            { id: 'v1', label: 'P', position: 0, stockQuantity: 3 },
            { id: 'v2', label: 'M', position: 1, stockQuantity: 5 },
            // Sold out, and still here: the storefront strikes it through.
            { id: 'v3', label: 'G', position: 2, stockQuantity: 0 },
          ],
        }),
      );

      const result = await serviceWith(prisma).findOne('camiseta-azul', {
        includeNonActive: false,
      });

      expect(result.stockQuantity).toBe(8);
      expect(result.variants).toHaveLength(3);
    });

    it('appends a new variant to the end and 409s a duplicate label', async () => {
      const prisma = createPrismaMock();
      prisma.product.findUnique.mockResolvedValue(
        productRow({
          variants: [
            { id: 'v1', label: 'P', position: 0, stockQuantity: 1 },
            { id: 'v2', label: 'M', position: 1, stockQuantity: 1 },
          ],
        }),
      );

      await serviceWith(prisma).addVariant('product-1', { label: 'G' });

      const [args] = prisma.productVariant.create.mock.calls[0] as [
        {
          data: {
            productId: string;
            label: string;
            position: number;
            stockQuantity: number;
          };
        },
      ];
      expect(args.data).toEqual({
        productId: 'product-1',
        label: 'G',
        position: 2,
        stockQuantity: 0,
      });

      prisma.productVariant.findFirst.mockResolvedValue({ id: 'v2' });
      await expect(
        serviceWith(prisma).addVariant('product-1', { label: 'M' }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
