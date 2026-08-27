import { Injectable, NotFoundException } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client';
import { ProductStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

/** What a stock write hands back: the variant, not the product. */
export interface VariantStock {
  id: string;
  label: string;
  position: number;
  stockQuantity: number;
}

/**
 * The one place stock numbers change — and, since
 * docs/specs/product-variants.md, the one place that knows stock belongs to a
 * VARIANT rather than to a product. There is no product-level count any more,
 * so there is no second code path that could decrement the wrong thing.
 *
 * Three operations on purpose, with different shapes: `setQuantity` is the
 * back-office correcting reality after counting shelves — an absolute write.
 * `decrement` is a sale — relative, and guarded. `restock` is a cancellation
 * returning units to the shelf — relative, unguarded. Orders calls the last
 * two; they are exported through CatalogModule precisely so `orders` never
 * touches the catalog's tables itself (docs/architecture/modules.md), and both
 * accept a transaction client so checkout/cancellation stay atomic across
 * the module boundary.
 */
@Injectable()
export class StockService {
  constructor(private readonly prisma: PrismaService) {}

  async setQuantity(
    variantId: string,
    quantity: number,
  ): Promise<VariantStock> {
    const existing = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException('Product variant not found');
    }

    return this.prisma.productVariant.update({
      where: { id: variantId },
      data: { stockQuantity: quantity },
      select: { id: true, label: true, position: true, stockQuantity: true },
    });
  }

  /**
   * Tries to take `quantity` units of one variant. Returns false when it
   * cannot.
   *
   * Check and decrement are a single conditional UPDATE — `WHERE stock >= n`
   * — so two checkouts racing for the last M are serialized by Postgres' row
   * lock, and exactly one wins. An application-side read-check-write would
   * pass both reads and oversell; that is the bug this service exists to make
   * unwritable.
   *
   * The status filter reaches through the relation to the owning product,
   * because lifecycle belongs to the product and a variant has no status of
   * its own. It is the catalog spec's "archived products refuse new sales"
   * invariant, one level down. An archived product, a missing variant and
   * insufficient stock all report the same false, because the caller's next
   * move (refuse the sale) is the same.
   */
  async decrement(
    variantId: string,
    quantity: number,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      // Caller bug, not user input: quantities reach here already validated.
      // A zero or negative "decrement" would silently mint stock.
      throw new Error(
        `decrement quantity must be a positive integer, got ${String(quantity)}`,
      );
    }

    const { count } = await (tx ?? this.prisma).productVariant.updateMany({
      where: {
        id: variantId,
        stockQuantity: { gte: quantity },
        product: { status: ProductStatus.ACTIVE },
      },
      data: { stockQuantity: { decrement: quantity } },
    });

    return count === 1;
  }

  /**
   * Puts `quantity` units back on the variant — a cancelled order returning
   * to the shelf.
   *
   * Deliberately unguarded where `decrement` is guarded: no status filter,
   * because the units physically exist even when the product has since been
   * archived (it just stays out of the storefront and keeps refusing new
   * sales). A missing variant row throws instead of returning false — the
   * only caller is cancellation, whose order items Restrict variant deletion,
   * so a miss here is a caller bug, not a condition to handle.
   */
  async restock(
    variantId: string,
    quantity: number,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      // Same reasoning as decrement: a zero or negative restock is a bug.
      throw new Error(
        `restock quantity must be a positive integer, got ${String(quantity)}`,
      );
    }

    const { count } = await (tx ?? this.prisma).productVariant.updateMany({
      where: { id: variantId },
      data: { stockQuantity: { increment: quantity } },
    });

    if (count !== 1) {
      throw new Error(`restock hit a missing product variant: ${variantId}`);
    }
  }
}
