import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ProductsService } from '../catalog/products.service';
import { ProductStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { itemCount, itemsSubtotalCents } from './money';

/**
 * The sellable slice of a product, as findSellableByVariantIds exposes it.
 *
 * No stock here: in a cart line the only number that means anything is the
 * stock of THAT size, which lives on the variant beside it. Handing back the
 * product's sum would invite showing "10 left" on a line whose M is gone
 * (docs/specs/product-variants.md).
 */
export interface LiveProduct {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  status: ProductStatus;
  /** Null until someone weighs it; shipping falls back to its own default. */
  weightGrams: number | null;
}

/** The size on this line, live from the catalogue. */
export interface LiveVariant {
  id: string;
  label: string;
  position: number;
  stockQuantity: number;
}

export interface CartView {
  items: {
    /** The line's identity — PATCH and DELETE address it. */
    variantId: string;
    quantity: number;
    /**
     * Live catalog data, deliberately not a snapshot: the cart holds no
     * money (docs/specs/orders.md). Status rides along so a front end can
     * warn "left the catalog" — deriving warnings is the client's job,
     * reporting current truth is ours.
     */
    product: LiveProduct;
    /** Same live read, one level down: label, order and this size's stock. */
    variant: LiveVariant;
  }[];

  /**
   * Sum of product.priceCents × quantity over the lines, measured server-side
   * against LIVE catalogue prices. Money arithmetic belongs here, not in a
   * browser (docs/specs/cart-totals.md), and an empty cart is 0 — never null,
   * never absent.
   */
  itemsSubtotalCents: number;

  /** Sum of quantities — the cart badge. Pieces, not lines. */
  itemCount: number;
}

const EMPTY_CART: CartView = {
  items: [],
  itemsSubtotalCents: 0,
  itemCount: 0,
};

const MAX_ITEM_QUANTITY = 999;

/**
 * The mutable half of the purchase flow. One cart per user, created lazily on
 * the first add; catalogue data is read through
 * ProductsService.findSellableByVariantIds — the exported contract — never by
 * joining catalog tables directly (docs/architecture/modules.md).
 *
 * Lines address a VARIANT, not a product: two sizes of one shirt are two
 * lines, and "the M" is the thing that can actually be bought
 * (docs/specs/product-variants.md).
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
      return { ...EMPTY_CART };
    }

    const variants = await this.products.findSellableByVariantIds(
      cart.items.map((item) => item.variantId),
    );
    const byId = new Map(variants.map((variant) => [variant.id, variant]));

    const items = cart.items.map((item) => {
      // The FK guarantees the row exists; a miss would be schema drift worth
      // crashing on, hence the lookup-then-assert.
      const variant = byId.get(item.variantId) as (typeof variants)[number];

      return {
        variantId: item.variantId,
        quantity: item.quantity,
        product: variant.product,
        variant: {
          id: variant.id,
          label: variant.label,
          position: variant.position,
          stockQuantity: variant.stockQuantity,
        },
      };
    });

    return {
      items,
      // The same function checkout uses to freeze itemsSubtotalCents onto the
      // order, so what is displayed and what is charged cannot drift apart.
      itemsSubtotalCents: itemsSubtotalCents(
        items.map((item) => ({
          unitPriceCents: item.product.priceCents,
          quantity: item.quantity,
        })),
      ),
      itemCount: itemCount(items),
    };
  }

  async addItem(
    userId: string,
    variantId: string,
    quantity: number,
  ): Promise<CartView> {
    this.assertValidQuantity(quantity);

    const variant = (
      await this.products.findSellableByVariantIds([variantId])
    ).at(0);

    // Hidden and missing are the same 404 on purpose, mirroring the public
    // catalog: a DRAFT product must not be discoverable through the cart, and
    // neither must one of its sizes.
    if (!variant || variant.product.status !== ProductStatus.ACTIVE) {
      throw new NotFoundException('Product variant not found');
    }

    // Lazy cart creation and the double-create race both land on the same
    // upsert against the userId unique — no check-then-write.
    const cart = await this.prisma.cart.upsert({
      where: { userId },
      create: { userId },
      update: {},
      select: { id: true },
    });

    // Repeat adds of the SAME SIZE sum quantities instead of duplicating the
    // line; the cartId+variantId unique makes this one statement. A different
    // size of the same product is a different line, which is the point.
    await this.prisma.cartItem.upsert({
      where: { cartId_variantId: { cartId: cart.id, variantId } },
      create: { cartId: cart.id, variantId, quantity },
      update: { quantity: { increment: quantity } },
    });

    return this.getCart(userId);
  }

  async setQuantity(
    userId: string,
    variantId: string,
    quantity: number,
  ): Promise<CartView> {
    this.assertValidQuantity(quantity);

    const cart = await this.findCartOrThrow(userId);

    const { count } = await this.prisma.cartItem.updateMany({
      where: { cartId: cart.id, variantId },
      data: { quantity },
    });

    if (count === 0) {
      throw new NotFoundException('Cart item not found');
    }

    return this.getCart(userId);
  }

  async removeItem(userId: string, variantId: string): Promise<CartView> {
    const cart = await this.findCartOrThrow(userId);

    const { count } = await this.prisma.cartItem.deleteMany({
      where: { cartId: cart.id, variantId },
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

    return { ...EMPTY_CART };
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
