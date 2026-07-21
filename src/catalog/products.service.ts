import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ProductStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { nextAvailableSlug, slugify } from './slug';

export interface CreateProductInput {
  name: string;
  slug?: string;
  description?: string;
  priceCents: number;
  imageUrls?: string[];
  status?: ProductStatus;
  stockQuantity?: number;
  categoryIds?: string[];
}

export type UpdateProductInput = Partial<CreateProductInput>;

export interface ListProductsInput {
  page?: number;
  perPage?: number;
  category?: string;
  search?: string;
  /**
   * Callers without products.read never get to set this — the controller
   * 403s them first. The service trusts it: no status means the public
   * default, ACTIVE only.
   */
  status?: ProductStatus | 'all';
}

const MAX_PER_PAGE = 100;

/**
 * Join rows travel as {category: {...}} — flatten so callers see categories,
 * not the join table that implements them.
 */
const CATEGORY_INCLUDE = {
  categories: {
    select: { category: { select: { id: true, name: true, slug: true } } },
  },
} as const;

/** Exported only so inferred controller return types can name it (TS4053). */
export interface WithCategoryRows {
  categories: { category: { id: string; name: string; slug: string } }[];
}

function flattenCategories<T extends WithCategoryRows>(row: T) {
  return { ...row, categories: row.categories.map((link) => link.category) };
}

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateProductInput) {
    const slug = await this.resolveSlug(input);
    await this.assertCategoriesExist(input.categoryIds);

    const created = await this.prisma.product.create({
      data: {
        name: input.name,
        slug,
        description: input.description,
        priceCents: input.priceCents,
        imageUrls: input.imageUrls ?? [],
        status: input.status,
        stockQuantity: input.stockQuantity,
        categories: this.categoryLinks(input.categoryIds),
      },
      include: CATEGORY_INCLUDE,
    });

    return flattenCategories(created);
  }

  async findMany(query: ListProductsInput) {
    const page = query.page ?? 1;
    const perPage = Math.min(query.perPage ?? 20, MAX_PER_PAGE);

    const where = {
      // No status requested = the public storefront view. 'all' = no filter,
      // reserved for viewers the controller already cleared for products.read.
      status:
        query.status === 'all'
          ? undefined
          : (query.status ?? ProductStatus.ACTIVE),
      categories: query.category
        ? { some: { category: { slug: query.category } } }
        : undefined,
      name: query.search
        ? { contains: query.search, mode: 'insensitive' as const }
        : undefined,
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        include: CATEGORY_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      items: (rows as (WithCategoryRows & Record<string, unknown>)[]).map(
        flattenCategories,
      ),
      total,
      page,
      perPage,
    };
  }

  async findOne(
    idOrSlug: string,
    { includeNonActive }: { includeNonActive: boolean },
  ) {
    const product = await this.prisma.product.findFirst({
      // The id is a UUID and the slug never looks like one, so the two
      // namespaces cannot collide; one lookup serves both URL styles.
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      include: CATEGORY_INCLUDE,
    });

    // Hidden and missing are the same 404 on purpose: a 403 would confirm to
    // anyone probing slugs that an unreleased product exists.
    if (
      !product ||
      (product.status !== ProductStatus.ACTIVE && !includeNonActive)
    ) {
      throw new NotFoundException('Product not found');
    }

    return flattenCategories(product);
  }

  /**
   * Bulk read of the sellable fields, for the orders module (the exported
   * contract in docs/architecture/modules.md — orders never queries the
   * products table itself). No status filter and no 404: cart views and
   * checkout need to see a product that went DRAFT/ARCHIVED to report it,
   * and which ids are missing is the caller's question to answer.
   */
  async findByIds(ids: string[]) {
    if (ids.length === 0) {
      return [];
    }

    return this.prisma.product.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        slug: true,
        priceCents: true,
        status: true,
        stockQuantity: true,
      },
    });
  }

  async update(id: string, input: UpdateProductInput) {
    const existing = await this.prisma.product.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('Product not found');
    }

    if (input.slug && input.slug !== existing.slug) {
      await this.assertSlugFree(input.slug, id);
    }

    await this.assertCategoriesExist(input.categoryIds);

    const updated = await this.prisma.product.update({
      where: { id },
      data: {
        name: input.name,
        slug: input.slug,
        description: input.description,
        priceCents: input.priceCents,
        imageUrls: input.imageUrls,
        status: input.status,
        stockQuantity: input.stockQuantity,
        // Absent means "not touching categories"; present means the sent list
        // IS the new truth — clear and rebuild in one nested write.
        categories: input.categoryIds
          ? { deleteMany: {}, ...this.categoryLinks(input.categoryIds) }
          : undefined,
      },
      include: CATEGORY_INCLUDE,
    });

    return flattenCategories(updated);
  }

  /**
   * The DELETE route lands here: archive, never remove. Orders will hold
   * product ids, and a sold product that vanishes takes its order history's
   * meaning with it. ARCHIVED leaves the storefront (and StockService refuses
   * to sell it) but the row stays.
   */
  async archive(id: string) {
    const existing = await this.prisma.product.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('Product not found');
    }

    const archived = await this.prisma.product.update({
      where: { id },
      data: { status: ProductStatus.ARCHIVED },
      include: CATEGORY_INCLUDE,
    });

    return flattenCategories(archived);
  }

  private categoryLinks(categoryIds?: string[]) {
    return categoryIds
      ? { create: categoryIds.map((categoryId) => ({ categoryId })) }
      : undefined;
  }

  private async assertCategoriesExist(categoryIds?: string[]): Promise<void> {
    if (!categoryIds || categoryIds.length === 0) {
      return;
    }

    const found = await this.prisma.category.count({
      where: { id: { in: categoryIds } },
    });

    // The FK would reject a bogus id anyway, but as an opaque 500. Counting
    // first turns "you sent a category that does not exist" into the 400 it is.
    if (found !== new Set(categoryIds).size) {
      throw new BadRequestException('One or more categories do not exist');
    }
  }

  private async resolveSlug(input: CreateProductInput): Promise<string> {
    if (input.slug) {
      await this.assertSlugFree(input.slug);
      return input.slug;
    }

    const base = slugify(input.name, 'produto');
    const taken = await this.prisma.product.findMany({
      where: { slug: { startsWith: base } },
      select: { slug: true },
    });

    return nextAvailableSlug(
      base,
      (taken as { slug: string }[]).map((row) => row.slug),
    );
  }

  private async assertSlugFree(slug: string, ownId?: string): Promise<void> {
    const holder = await this.prisma.product.findUnique({
      where: { slug },
      select: { id: true },
    });

    if (holder && holder.id !== ownId) {
      throw new ConflictException(`Slug "${slug}" is already in use`);
    }
  }
}
