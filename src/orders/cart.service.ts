import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ProductsService } from '../catalog/products.service';
import { ProductStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

/** What findByIds exposes — the sellable slice of a product. */
export interface LiveProduct {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  status: ProductStatus;
  stockQuantity: number;
  /** Null until someone weighs it; shipping falls back to its own default. */
  weightGrams: number | null;
}

export interface CartView {
  items: {
    productId: string;
    quantity: number;
    /**
     * Live catalog data, deliberately not a snapshot: the cart holds no
     * money (docs/specs/orders.md). Status and stock ride along so a front
     * end can warn "left the catalog" / "only 2 left" — deriving warnings is
     * the client's job, reporting current truth is ours.
     */
    product: LiveProduct;
  }[];
}

const MAX_ITEM_QUANTITY = 999;

/**
 * The mutable half of the purchase flow. One cart per user, created lazily on
 * the first add; product data is read through ProductsService.findByIds — the
 * exported catalog contract — never by joining catalog tables directly
 * (docs/architecture/modules.md).
 */
@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
  ) {}

  async getCart(userId: string): Promise<CartView> {
    const cart = await this.prisma.cart.findUnique({
      where: { userId },
      include: { items: { orderBy: { id: 'asc' } } },
    });

    if (!cart || cart.items.length === 0) {
      return { items: [] };
    }

    const products = await this.products.findByIds(
      cart.items.map((item) => item.productId),
    );
    const byId = new Map(products.map((product) => [product.id, product]));

    return {
      items: cart.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        // The FK guarantees the row exists; a miss would be schema drift
        // worth crashing on, hence the non-null assertion via lookup+throw.
        product: byId.get(item.productId) as LiveProduct,
      })),
    };
  }

  async addItem(
    userId: string,
    productId: string,
    quantity: number,
  ): Promise<CartView> {
    this.assertValidQuantity(quantity);

    const product = (await this.products.findByIds([productId])).at(0);

    // Hidden and missing are the same 404 on purpose, mirroring the public
    // catalog: a DRAFT product must not be discoverable through the cart.
    if (!product || product.status !== ProductStatus.ACTIVE) {
      throw new NotFoundException('Product not found');
    }

    // Lazy cart creation and the double-create race both land on the same
    // upsert against the userId unique — no check-then-write.
    const cart = await this.prisma.cart.upsert({
      where: { userId },
      create: { userId },
      update: {},
      select: { id: true },
    });

    // Repeat adds sum quantities instead of duplicating the line; the
    // cartId+productId unique makes this one statement.
    await this.prisma.cartItem.upsert({
      where: { cartId_productId: { cartId: cart.id, productId } },
      create: { cartId: cart.id, productId, quantity },
      update: { quantity: { increment: quantity } },
    });

    return this.getCart(userId);
  }

  async setQuantity(
    userId: string,
    productId: string,
    quantity: number,
  ): Promise<CartView> {
    this.assertValidQuantity(quantity);

    const cart = await this.findCartOrThrow(userId);

    const { count } = await this.prisma.cartItem.updateMany({
      where: { cartId: cart.id, productId },
      data: { quantity },
    });

    if (count === 0) {
      throw new NotFoundException('Cart item not found');
    }

    return this.getCart(userId);
  }

  async removeItem(userId: string, productId: string): Promise<CartView> {
    const cart = await this.findCartOrThrow(userId);

    const { count } = await this.prisma.cartItem.deleteMany({
      where: { cartId: cart.id, productId },
    });

    if (count === 0) {
      throw new NotFoundException('Cart item not found');
    }

    return this.getCart(userId);
  }

  async clear(userId: string): Promise<CartView> {
    const cart = await this.prisma.cart.findUnique({
      where: { userId },
      select: { id: true },
    });

    // No cart is not an error: the caller asked for an empty cart and,
    // vacuously, already has one.
    if (cart) {
      await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    }

    return { items: [] };
  }

  private async findCartOrThrow(userId: string): Promise<{ id: string }> {
    const cart = await this.prisma.cart.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!cart) {
      // Adjusting an item in a cart that never existed is the same miss as
      // adjusting an item that is not there.
      throw new NotFoundException('Cart item not found');
    }

    return cart;
  }

  /**
   * Belt to the DTO's suspenders: quantities also arrive here from future
   * internal callers, and a zero or negative write would corrupt the cart
   * (the DB CHECK would catch it last).
   */
  private assertValidQuantity(quantity: number): void {
    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_ITEM_QUANTITY
    ) {
      throw new BadRequestException(
        `quantity must be an integer between 1 and ${String(MAX_ITEM_QUANTITY)}`,
      );
    }
  }
}
