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
 * The two halves of a destructive confirmation, which only mean something
 * together (docs/specs/variant-management.md).
 *
 * `discardCartLines` is the AUTHORISATION — "I accept deleting other people's
 * cart lines". `expectedCartLineCount` is the CONFIRMED IMPACT — "the damage I
 * reviewed was this big". Authorising the class of action is not the same as
 * accepting any size of it, so an authorisation without a reviewed number is a
 * blank cheque and is refused.
 */
export interface RemoveVariantConfirmation {
  discardCartLines: boolean;
  expectedCartLineCount?: number;
}

/** Prisma's unique-constraint violation — a label already on this product. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * Prisma's foreign-key violation. Here it means order_items RESTRICTing the
 * deletion of a size somebody bought — the guarantee behind the pre-check.
 */
const FOREIGN_KEY_VIOLATION = 'P2003';

function hasPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === code
  );
}

/** Kept identical wherever the refusal is raised, pre-check or FK. */
const SOLD_VARIANT_MESSAGE = 'This size has been sold and cannot be removed';

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
        //
        // Past the HIGHEST position, not past the COUNT — the two only agree
        // while positions are dense from zero, and they need not be: callers
        // choose positions at create time, and removing from the middle leaves
        // a gap. Counting would drop the new size on top of an existing one
        // and let a UUID tiebreaker decide the display order, which is the one
        // thing this column exists to prevent.
        position: input.position ?? this.nextPosition(product.variants),
        stockQuantity: input.stockQuantity ?? 0,
      },
    });

    return this.findById(productId);
  }

  /**
   * Renames one size.
   *
   * Safe for history by construction: `order_items.variant_label` is a
   * snapshot taken at purchase, so no placed order is reachable from here. The
   * cart is the opposite and equally deliberate — it holds no snapshot, so a
   * line simply starts reading the new label, which is the current truth it
   * promised (docs/specs/variant-management.md).
   */
  async renameVariant(productId: string, variantId: string, label: string) {
    const variant = await this.prisma.productVariant.findFirst({
      where: { id: variantId, productId },
      select: { id: true, label: true },
    });

    if (!variant) {
      throw new NotFoundException('Product variant not found');
    }

    // Renaming a size to what it already is asks for nothing. Skipping here
    // matters: the uniqueness check below would otherwise find this very row
    // and report a clash with itself.
    if (variant.label === label) {
      return this.findById(productId);
    }

    const taken = await this.prisma.productVariant.findFirst({
      where: { productId, label },
      select: { id: true },
    });

    if (taken) {
      throw new ConflictException(
        `This product already has a "${label}" variant`,
      );
    }

    try {
      await this.prisma.productVariant.update({
        where: { id: variantId },
        data: { label },
      });
    } catch (error) {
      // Two renames racing for the same free label: the unique index settles
      // it, and the loser gets the same 409 the pre-check would have given.
      if (hasPrismaCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException(
          `This product already has a "${label}" variant`,
        );
      }
      throw error;
    }

    return this.findById(productId);
  }

  /**
   * Rewrites the whole display order in one transaction.
   *
   * The body is the EXACT set of the product's variants, in the order wanted,
   * and positions become the index within it. A partial list is refused rather
   * than merged: it does not say where the sizes it left out are supposed to
   * go, and inventing an answer is how an ordering silently stops matching
   * what the operator saw. Same reasoning as `categoryIds` on PATCH /products,
   * which also replaces the set instead of merging into it.
   *
   * No swap dance is needed because `position` has no uniqueness
   * (docs/specs/product-variants.md) — the whole list is simply restated.
   */
  async reorderVariants(productId: string, variantIds: string[]) {
    const existing = await this.prisma.productVariant.findMany({
      where: { productId },
      select: { id: true },
    });

    // Every product has at least one variant, so an empty set means the
    // product itself is not there.
    if (existing.length === 0) {
      throw new NotFoundException('Product not found');
    }

    this.assertIsExactVariantSet(existing, variantIds);

    await this.prisma.$transaction(
      variantIds.map((id, index) =>
        this.prisma.productVariant.update({
          where: { id },
          data: { position: index },
        }),
      ),
    );

    return this.findById(productId);
  }

  /**
   * Removes one size, under the policy in docs/specs/variant-management.md.
   *
   * Three walls, in the order the operator cannot argue with them:
   *
   * 1. the last variant never goes — a product with none is unbuyable, and no
   *    flag overrides it (archive the product instead);
   * 2. a size somebody bought never goes — `order_items` RESTRICTs it, and the
   *    count here exists to turn that refusal into a sentence;
   * 3. cart lines do not veto, but they are not discarded by accident either:
   *    the caller must authorise the destruction AND confirm its size.
   *
   * Everything destructive happens inside one transaction that starts by
   * locking the product's variant rows. That lock is load-bearing: inserting a
   * cart line takes FOR KEY SHARE on the variant it points at, which FOR
   * UPDATE conflicts with, so no cart can slip in between the recount and the
   * delete — and two concurrent removals cannot both read "two variants left"
   * and both delete one.
   */
  async removeVariant(
    productId: string,
    variantId: string,
    confirmation: RemoveVariantConfirmation,
  ) {
    this.assertConfirmationIsWhole(confirmation);
    await this.assertVariantBelongsTo(productId, variantId);

    // Outside the transaction on purpose: it is the message, not the
    // guarantee. A checkout committing after this point is caught by the FK.
    const soldCount = await this.prisma.orderItem.count({
      where: { variantId },
    });

    if (soldCount > 0) {
      throw new ConflictException(SOLD_VARIANT_MESSAGE);
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        // ORDER BY id so two concurrent removals on the same product take the
        // rows in the same order and queue instead of deadlocking.
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "product_variants"
          WHERE "product_id" = ${productId}
          ORDER BY "id"
          FOR UPDATE
        `;

        if (locked.length <= 1) {
          throw new ConflictException(
            'A product must keep at least one variant',
          );
        }

        // It was there a moment ago; a concurrent removal got it first.
        if (!locked.some((row) => row.id === variantId)) {
          throw new NotFoundException('Product variant not found');
        }

        const cartLineCount = await tx.cartItem.count({ where: { variantId } });

        this.assertImpactWasReviewed(confirmation, cartLineCount);

        // Explicitly, rather than leaving it to onDelete: Cascade. The cascade
        // stays in the schema as a referential safety net, but a rule that
        // deletes customer data has to be a line of code somebody can read,
        // test and find — not a clause in a constraint definition.
        await tx.cartItem.deleteMany({ where: { variantId } });
        await tx.productVariant.delete({ where: { id: variantId } });
      });
    } catch (error) {
      // RESTRICT firing means a sale landed between the count and the delete.
      if (hasPrismaCode(error, FOREIGN_KEY_VIOLATION)) {
        throw new ConflictException(SOLD_VARIANT_MESSAGE);
      }
      throw error;
    }

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

  /** One past the highest position in use — "the end of the list", literally. */
  private nextPosition(variants: { position: number }[]): number {
    return variants.reduce(
      (highest, variant) => Math.max(highest, variant.position + 1),
      0,
    );
  }

  /**
   * The reorder body has to BE the product's variants: same members, no
   * repeats, nothing missing, nobody else's.
   */
  private assertIsExactVariantSet(
    existing: { id: string }[],
    variantIds: string[],
  ): void {
    const sent = new Set(variantIds);

    if (sent.size !== variantIds.length) {
      throw new BadRequestException('variantIds must not repeat a variant');
    }

    if (
      sent.size !== existing.length ||
      existing.some((variant) => !sent.has(variant.id))
    ) {
      throw new BadRequestException(
        "variantIds must list exactly this product's variants, in the order wanted",
      );
    }
  }

  /**
   * The two halves of the confirmation travel together or not at all.
   *
   * An authorisation with no reviewed impact is signed once and good for any
   * amount of damage; a reviewed impact with no authorisation asks for
   * nothing. Neither is a request this route can answer honestly.
   */
  private assertConfirmationIsWhole(
    confirmation: RemoveVariantConfirmation,
  ): void {
    const hasCount = confirmation.expectedCartLineCount !== undefined;

    if (confirmation.discardCartLines && !hasCount) {
      throw new BadRequestException(
        'discardCartLines requires expectedCartLineCount: confirm the impact you reviewed',
      );
    }

    if (!confirmation.discardCartLines && hasCount) {
      throw new BadRequestException(
        'expectedCartLineCount requires discardCartLines=true',
      );
    }
  }

  /**
   * Wall 3, decided against a count taken under the row lock.
   *
   * A mismatch in EITHER direction aborts, including one where the damage
   * shrank: the rule is that the impact confirmed is the impact applied, and a
   * number that no longer describes reality was not reviewed, it was guessed.
   * The 409 carries the current count so the next attempt is an informed one.
   */
  private assertImpactWasReviewed(
    confirmation: RemoveVariantConfirmation,
    cartLineCount: number,
  ): void {
    if (!confirmation.discardCartLines) {
      if (cartLineCount > 0) {
        throw new ConflictException({
          message: `This size is in ${String(cartLineCount)} shopping carts`,
          cartLineCount,
        });
      }
      return;
    }

    if (cartLineCount !== confirmation.expectedCartLineCount) {
      throw new ConflictException({
        message: `Cart line count changed from ${String(
          confirmation.expectedCartLineCount,
        )} to ${String(cartLineCount)}; review and confirm again`,
        cartLineCount,
      });
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
