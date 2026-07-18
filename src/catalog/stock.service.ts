import { Injectable, NotFoundException } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client';
import { ProductStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The one place stock numbers change.
 *
 * Three operations on purpose, with different shapes: `setQuantity` is the
 * back-office correcting reality after counting shelves — an absolute write.
 * `decrement` is a sale — relative, and guarded. `restock` is a cancellation
 * returning units to the shelf — relative, unguarded. Orders calls the last
 * two; they are exported through CatalogModule precisely so `orders` never
 * touches the products table itself (docs/architecture/modules.md), and both
 * accept a transaction client so checkout/cancellation stay atomic across
 * the module boundary.
 */
@Injectable()
export class StockService {
  constructor(private readonly prisma: PrismaService) {}

  async setQuantity(
    productId: string,
    quantity: number,
  ): Promise<{ id: string; stockQuantity: number }> {
    const existing = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException('Product not found');
    }

    return this.prisma.product.update({
      where: { id: productId },
      data: { stockQuantity: quantity },
      select: { id: true, stockQuantity: true },
    });
  }

  /**
   * Tries to take `quantity` units. Returns false when it cannot.
   *
   * Check and decrement are a single conditional UPDATE — `WHERE stock >= n`
   * — so two checkouts racing for the last unit are serialized by Postgres'
   * row lock, and exactly one wins. An application-side read-check-write
   * would pass both reads and oversell; that is the bug this service exists
   * to make unwritable. The status filter is the "archived products refuse
   * new sales" invariant from the spec: an archived or missing product and
   * insufficient stock all report the same false, because the caller's next
   * move (refuse the sale) is the same.
   */
  async decrement(
    productId: string,
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

    const { count } = await (tx ?? this.prisma).product.updateMany({
      where: {
        id: productId,
        status: ProductStatus.ACTIVE,
        stockQuantity: { gte: quantity },
      },
      data: { stockQuantity: { decrement: quantity } },
    });

    return count === 1;
  }

  /**
   * Puts `quantity` units back — a cancelled order returning to the shelf.
   *
   * Deliberately unguarded where `decrement` is guarded: no status filter,
   * because the units physically exist even when the product has since been
   * archived (it just stays out of the storefront and keeps refusing new
   * sales). A missing product row throws instead of returning false — the
   * only caller is cancellation, whose order items Restrict product deletion,
   * so a miss here is a caller bug, not a condition to handle.
   */
  async restock(
    productId: string,
    quantity: number,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      // Same reasoning as decrement: a zero or negative restock is a bug.
      throw new Error(
        `restock quantity must be a positive integer, got ${String(quantity)}`,
      );
    }

    const { count } = await (tx ?? this.prisma).product.updateMany({
      where: { id: productId },
      data: { stockQuantity: { increment: quantity } },
    });

    if (count !== 1) {
      throw new Error(`restock hit a missing product: ${productId}`);
    }
  }
}
