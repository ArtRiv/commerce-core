import { ApiProperty } from '@nestjs/swagger';

import { ProductStatus } from '../../generated/prisma/enums';

/**
 * The sellable slice of a product, read LIVE from the catalog every time the
 * cart is read — not a snapshot. A cart holds no money: it stores product ids
 * and quantities, and the price you see is the price the catalog has right
 * now. Freezing happens at checkout and nowhere earlier.
 */
export class CartProductResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Camiseta Azul' })
  name: string;

  @ApiProperty({ example: 'camiseta-azul' })
  slug: string;

  @ApiProperty({
    description: 'Current catalog price, in cents.',
    example: 7990,
  })
  priceCents: number;

  @ApiProperty({
    enum: ProductStatus,
    description:
      'Anything other than ACTIVE means checkout will refuse this line with a 409 until it is removed.',
  })
  status: ProductStatus;

  @ApiProperty({
    description:
      'Current stock. Lower than the line quantity is not an error here — it becomes one at checkout.',
    example: 3,
  })
  stockQuantity: number;

  @ApiProperty({ nullable: true, type: Number, example: 180 })
  weightGrams: number | null;
}

export class CartItemResponse {
  @ApiProperty({ format: 'uuid' })
  productId: string;

  @ApiProperty({ minimum: 1, maximum: 999, example: 2 })
  quantity: number;

  @ApiProperty({ type: CartProductResponse })
  product: CartProductResponse;
}

/**
 * No id and no owner field: there is only ever the caller's cart, and it is
 * created lazily on the first add. An empty or not-yet-existing cart is the
 * same empty list with both totals at zero, which is why no cart route
 * answers 404.
 *
 * The totals are computed here, not in the client. Summing money in a browser
 * is a backend gap wearing a frontend costume — every store that deploys this
 * core has a cart with a total in it (docs/specs/cart-totals.md).
 */
export class CartResponse {
  @ApiProperty({ type: [CartItemResponse] })
  items: CartItemResponse[];

  @ApiProperty({
    description:
      'Sum of `product.priceCents × quantity` over the lines, in cents, computed server-side against LIVE catalogue prices. Reprice a product and this follows on the next read — the cart freezes nothing; checkout does. An empty cart is `0`, never null and never absent.',
    example: 12480,
  })
  itemsSubtotalCents: number;

  @ApiProperty({
    description:
      'Sum of quantities — pieces, not lines. This is the cart badge: two shirts and a pair of trousers is 3, not 2. An empty cart is `0`.',
    example: 3,
  })
  itemCount: number;
}
