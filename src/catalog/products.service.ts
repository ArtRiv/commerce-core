import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ProductStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { nextAvailableSlug, slugify } from './slug';

/** One sellable size. Stock lives here and nowhere else. */
export interface CreateVariantInput {
  label: string;
  /** Absent = its index in the list. Never sorted alphabetically. */
  position?: number;
  /** Absent = 0: a size that exists but has none left is a real state. */
  stockQuantity?: number;
}

export interface CreateProductInput {
  name: string;
  slug?: string;
  description?: string;
  priceCents: number;
  imageUrls?: string[];
  status?: ProductStatus;
  /**
   * The sellable units. Absent means ONE variant labelled `Único` — never
   * zero, because a product with no variant is unbuyable and "product without
   * variants" is the second code path this module exists to not have
   * (docs/specs/product-variants.md).
   */
  variants?: CreateVariantInput[];
  /** Grams, for freight quoting. Null/absent falls back to the configured default. */
  weightGrams?: number | null;
  categoryIds?: string[];
}

/**
 * Variants are deliberately NOT updatable through here. Replacing the set
 * wholesale — the way categoryIds is replaced — would have to decide what
 * happens to a size somebody has already bought, and `order_items` Restricts
 * that deletion. Adding one has its own route; renaming and removing are
 * deferred decisions with the reasoning in the spec.
 */
export type UpdateProductInput = Partial<Omit<CreateProductInput, 'variants'>>;

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
  /** Defaults to 'newest', which is the ordering this endpoint always had. */
  sort?: ProductSort;
  /** Inclusive, integer cents. */
  minPriceCents?: number;
  /** Inclusive, integer cents. */
  maxPriceCents?: number;
}

const MAX_PER_PAGE = 100;

/**
 * The orderings GET /products offers. Sorting and pagination are one feature:
 * an ORDER BY applied after the LIMIT sorts the page, not the catalogue, so a
 * client that sorts what it was handed is only correct while the whole
 * catalogue fits in one page.
 */
export const PRODUCT_SORTS = [
  'newest',
  'price_asc',
  'price_desc',
  'name_asc',
] as const;

export type ProductSort = (typeof PRODUCT_SORTS)[number];

/**
 * Every ordering ends in id asc. Without a tiebreaker two products with the
 * same price can swap places between two queries, and pagination then shows
 * one twice and hides the other.
 */
const ORDER_BY: Record<
  ProductSort,
  {
    createdAt?: 'asc' | 'desc';
    priceCents?: 'asc' | 'desc';
    name?: 'asc' | 'desc';
    id?: 'asc';
  }[]
> = {
  newest: [{ createdAt: 'desc' }, { id: 'asc' }],
  price_asc: [{ priceCents: 'asc' }, { id: 'asc' }],
  price_desc: [{ priceCents: 'desc' }, { id: 'asc' }],
  name_asc: [{ name: 'asc' }, { id: 'asc' }],
};

/** The label a product with no sizes of its own gets. Never absent. */
export const SINGLE_VARIANT_LABEL = 'Único';

/**
 * Position first, id as the tiebreaker — the same shape every ordering in this
 * service has, and for the same reason: without it two variants sharing a
 * position can swap places between two reads.
 *
 * Declared apart from the include below because that one is `as const`, and a
 * readonly tuple is not what Prisma's orderBy accepts.
 */
const VARIANT_ORDER: {
  position?: 'asc';
  id?: 'asc';
}[] = [{ position: 'asc' }, { id: 'asc' }];

/**
 * Join rows travel as {category: {...}} — flatten so callers see categories,
 * not the join table that implements them.
 *
 * Variants come along on every product read: they ARE the sellable units, and
 * the product's own stockQuantity is derived from them (there is no column
 * left to read it from). Ordered by position, never by label — P/M/G/GG/XGG
 * sorts alphabetically to G, GG, M, P, XGG — with the same `id` tiebreaker
 * every other ordering in this service has.
 */
const PRODUCT_INCLUDE = {
  categories: {
    select: { category: { select: { id: true, name: true, slug: true } } },
  },
  variants: {
    select: { id: true, label: true, position: true, stockQuantity: true },
    orderBy: VARIANT_ORDER,
  },
} as const;

/** Exported only so inferred controller return types can name it (TS4053). */
export interface WithCategoryRows {
  categories: { category: { id: string; name: string; slug: string } }[];
  variants: {
    id: string;
    label: string;
    position: number;
    stockQuantity: number;
  }[];
}

/**
 * Flattens the join rows and derives the product's stock from its variants.
 *
 * `stockQuantity` survives on the response — the catalogue grid still says
 * "Esgotado" from one number — but it is a SUM computed here, never a stored
 * column. A stored copy would be a second place for stock to live and a second
 * place for it to be wrong (docs/specs/product-variants.md).
 */
function toProductView<T extends WithCategoryRows>(row: T) {
  return {
    ...row,
    categories: row.categories.map((link) => link.category),
    stockQuantity: row.variants.reduce(
      (total, variant) => total + variant.stockQuantity,
      0,
    ),
  };
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
        weightGrams: input.weightGrams,
        categories: this.categoryLinks(input.categoryIds),
        variants: { create: this.variantRows(input.variants) },
      },
      include: PRODUCT_INCLUDE,
    });

    return toProductView(created);
  }

  /**
   * Adds one size to a product that already exists.
   *
   * Creating is the only variant mutation v1 offers, and that is a deliberate
   * line: adding a size cannot invalidate anything, while removing one has to
   * decide what happens to orders that already bought it (`order_items`
   * Restricts the deletion), and that is a policy decision rather than a
   * detail. Renaming is deferred for the same reason — and is already harmless
   * to history, because order items snapshot the label.
   */
  async addVariant(productId: string, input: CreateVariantInput) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, variants: { select: { position: true } } },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const taken = await this.prisma.productVariant.findFirst({
      where: { productId, label: input.label },
      select: { id: true },
    });

    // The unique index would reject this anyway, as an opaque 500. Checking
    // first turns "that size already exists" into the 409 it is.
    if (taken) {
      throw new ConflictException(
        `This product already has a "${input.label}" variant`,
      );
    }

    await this.prisma.productVariant.create({
      data: {
        productId,
        label: input.label,
        // Appended to the end by default: a new size added later is almost
        // always the next one along, and guessing anything cleverer would be
        // wrong for XGG and for 46 alike.
        position: input.position ?? product.variants.length,
        stockQuantity: input.stockQuantity ?? 0,
      },
    });

    return this.findById(productId);
  }

  async findMany(query: ListProductsInput) {
    const page = query.page ?? 1;
    const perPage = Math.min(query.perPage ?? 20, MAX_PER_PAGE);

    // An impossible range is the caller's bug. Returning [] would hide it
    // behind a result that looks like "nothing matched".
    if (
      query.minPriceCents !== undefined &&
      query.maxPriceCents !== undefined &&
      query.minPriceCents > query.maxPriceCents
    ) {
      throw new BadRequestException(
        'minPriceCents cannot be greater than maxPriceCents',
      );
    }

    const priceCents =
      query.minPriceCents !== undefined || query.maxPriceCents !== undefined
        ? { gte: query.minPriceCents, lte: query.maxPriceCents }
        : undefined;

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
      priceCents,
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        include: PRODUCT_INCLUDE,
        orderBy: ORDER_BY[query.sort ?? 'newest'],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      items: (rows as (WithCategoryRows & Record<string, unknown>)[]).map(
        toProductView,
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
      include: PRODUCT_INCLUDE,
    });

    // Hidden and missing are the same 404 on purpose: a 403 would confirm to
    // anyone probing slugs that an unreleased product exists.
    if (
      !product ||
      (product.status !== ProductStatus.ACTIVE && !includeNonActive)
    ) {
      throw new NotFoundException('Product not found');
    }

    return toProductView(product);
  }

  /**
   * Bulk read of the sellable fields BY VARIANT, for the orders module (the
   * exported contract in docs/architecture/modules.md — orders never queries
   * the catalog's tables itself).
   *
   * Keyed on variants rather than products because that is what a cart line
   * and an order line address now. No status filter and no 404: cart views and
   * checkout need to see a product that went DRAFT/ARCHIVED in order to report
   * it, and which ids are missing is the caller's question to answer.
   */
  async findSellableByVariantIds(variantIds: string[]) {
    if (variantIds.length === 0) {
      return [];
    }

    return this.prisma.productVariant.findMany({
      where: { id: { in: variantIds } },
      select: {
        id: true,
        label: true,
        position: true,
        stockQuantity: true,
        product: {
          select: {
            id: true,
            name: true,
            slug: true,
            priceCents: true,
            status: true,
            // Freight needs it, and orders resolves it through this contract
            // rather than reading the products table (docs/specs/shipping.md).
            // Weight stays on the PRODUCT: a GG weighs more than a P and the
            // difference moves no bracket in any table this repo can quote.
            weightGrams: true,
          },
        },
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
        weightGrams: input.weightGrams,
        // Absent means "not touching categories"; present means the sent list
        // IS the new truth — clear and rebuild in one nested write.
        categories: input.categoryIds
          ? { deleteMany: {}, ...this.categoryLinks(input.categoryIds) }
          : undefined,
      },
      include: PRODUCT_INCLUDE,
    });

    return toProductView(updated);
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
      include: PRODUCT_INCLUDE,
    });

    return toProductView(archived);
  }

  /**
   * Refuses a variant id that belongs to a different product.
   *
   * The stock route addresses a variant UNDER its product, so without this the
   * product segment of the URL would be decoration and any variant in the
   * catalogue would be writable through any product's path.
   */
  async assertVariantBelongsTo(
    productId: string,
    variantId: string,
  ): Promise<void> {
    const variant = await this.prisma.productVariant.findFirst({
      where: { id: variantId, productId },
      select: { id: true },
    });

    if (!variant) {
      // Same 404 for "no such product", "no such variant" and "that variant is
      // someone else's": the caller has no business learning which.
      throw new NotFoundException('Product variant not found');
    }
  }

  /** Reads a product back by id, in the shape every route answers with. */
  private async findById(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: PRODUCT_INCLUDE,
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return toProductView(product);
  }

  /**
   * Turns the requested sizes into rows, and turns "no sizes" into ONE size.
   *
   * The fallback is the invariant, not a convenience: every product has at
   * least one variant, always, so no reader ever has to handle a product with
   * none. `position` defaults to the index, which is what makes sending
   * ['P','M','G','GG','XGG'] in order simply work.
   */
  private variantRows(variants?: CreateVariantInput[]) {
    if (!variants || variants.length === 0) {
      return [{ label: SINGLE_VARIANT_LABEL, position: 0, stockQuantity: 0 }];
    }

    const labels = variants.map((variant) => variant.label);

    // The unique index would reject this as an opaque 500. Naming it here
    // makes "you sent two variants called M" the 400 it is.
    if (new Set(labels).size !== labels.length) {
      throw new BadRequestException(
        'Variant labels must be unique per product',
      );
    }

    return variants.map((variant, index) => ({
      label: variant.label,
      position: variant.position ?? index,
      stockQuantity: variant.stockQuantity ?? 0,
    }));
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
