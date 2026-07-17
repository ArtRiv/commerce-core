import { Injectable, NotFoundException } from '@nestjs/common';

import { ProductStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The one place stock numbers change.
 *
 * Two operations on purpose, with different shapes: `setQuantity` is the
 * back-office correcting reality after counting shelves — an absolute write.
 * `decrement` is a sale — relative, and guarded. Orders will call `decrement`
 * at checkout; it is exported through CatalogModule precisely so `orders`
 * never touches the products table itself (docs/architecture/modules.md).
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
  async decrement(productId: string, quantity: number): Promise<boolean> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      // Caller bug, not user input: quantities reach here already validated.
      // A zero or negative "decrement" would silently mint stock.
      throw new Error(
        `decrement quantity must be a positive integer, got ${String(quantity)}`,
      );
    }

    const { count } = await this.prisma.product.updateMany({
      where: {
        id: productId,
        status: ProductStatus.ACTIVE,
        stockQuantity: { gte: quantity },
      },
      data: { stockQuantity: { decrement: quantity } },
    });

    return count === 1;
  }
}
