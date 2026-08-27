import { ApiProperty } from '@nestjs/swagger';

import { ProductStatus } from '../../generated/prisma/enums';

/**
 * The sellable slice of a product, read LIVE from the catalog every time the
 * cart is read — not a snapshot. A cart holds no money: it stores variant ids
 * and quantities, and the price you see is the price the catalog has right
 * now. Freezing happens at checkout and nowhere earlier.
 *
 * There is deliberately NO stockQuantity here. On a cart line the only number
 * that means anything is the stock of that SIZE, which is on `variant`
 * alongside; the product's sum would invite showing "10 left" on a line whose
 * M is gone (docs/specs/product-variants.md).
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

  @ApiProperty({ nullable: true, type: Number, example: 180 })
  weightGrams: number | null;
}

/** The size on this line, read live from the catalogue with the product. */
export class CartVariantResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'M' })
  label: string;

  @ApiProperty({
    description: 'The size’s display order on its product.',
    example: 1,
  })
  position: number;

  @ApiProperty({
    description:
      'Current stock of THIS size. Lower than the line quantity is not an error here — it becomes one at checkout, with a 409 naming the piece.',
    example: 3,
  })
  stockQuantity: number;
}

export class CartItemResponse {
  @ApiProperty({
    format: 'uuid',
    description:
      'The line’s identity. PATCH /cart/items/{variantId} and DELETE /cart/items/{variantId} address this, not the product — two sizes of one shirt are two lines.',
  })
  variantId: string;

  @ApiProperty({ minimum: 1, maximum: 999, example: 2 })
  quantity: number;

  @ApiProperty({ type: CartProductResponse })
  product: CartProductResponse;

  @ApiProperty({ type: CartVariantResponse })
  variant: CartVariantResponse;
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
