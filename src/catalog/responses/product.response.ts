import { ApiProperty } from '@nestjs/swagger';

import { ProductStatus } from '../../generated/prisma/enums';
import { ProductCategoryResponse } from './category.response';

/**
 * One sellable size. This is what a cart line and an order line address — a
 * bare product id is no longer buyable.
 *
 * A variant with `stockQuantity: 0` is STILL HERE. The storefront strikes the
 * size through; it never hides it. "Sold out, come back" and "we do not make
 * that size" are different sentences, and only the response can tell them
 * apart. See docs/specs/product-variants.md.
 */
export class ProductVariantResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    description:
      'What the customer picks. `Único` is what a product with no sizes of its own carries — every product has at least one variant, always.',
    example: 'M',
  })
  label: string;

  @ApiProperty({
    description:
      'Display order, ascending. Explicit because alphabetical is wrong: P/M/G/GG/XGG sorts to G, GG, M, P, XGG. Ties break by `id`, so the order is stable across requests.',
    example: 1,
  })
  position: number;

  @ApiProperty({
    description:
      'Stock for THIS size. Zero means sold out, not missing — render the size struck through rather than dropping it.',
    example: 4,
  })
  stockQuantity: number;
}

export class ProductResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Camiseta Azul' })
  name: string;

  @ApiProperty({
    description:
      'URL identity. Mutable — GET /products/{idOrSlug} also accepts the immutable id, which is the safer choice for a link that must not break.',
    example: 'camiseta-azul',
  })
  slug: string;

  @ApiProperty({ nullable: true, type: String })
  description: string | null;

  @ApiProperty({
    description: 'Integer cents, always greater than zero. Never a float.',
    example: 7990,
  })
  priceCents: number;

  @ApiProperty({
    type: [String],
    description: 'Plain URLs. This API does not host images in v1.',
    example: ['https://cdn.example.com/camiseta-azul.jpg'],
  })
  imageUrls: string[];

  @ApiProperty({
    enum: ProductStatus,
    description:
      'Only ACTIVE products are visible without the `products.read` permission. DELETE archives rather than deleting, so ARCHIVED rows persist forever.',
  })
  status: ProductStatus;

  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'Unit weight in grams, used to price freight. Null means the store has never weighed it, and quotes fall back to a configured default — which the store pays for when the guess is low.',
    example: 180,
  })
  weightGrams: number | null;

  @ApiProperty({
    description:
      'The SUM across `variants`, computed on read — there is no stock column on a product any more. Good enough for a grid that says "Esgotado" from one number; useless for deciding whether a specific size can be bought. For that, read `variants[].stockQuantity`.',
    example: 42,
  })
  stockQuantity: number;

  @ApiProperty({
    type: [ProductVariantResponse],
    description:
      'The sellable units, ordered by `position`. **Never empty** — a product with no sizes of its own carries one labelled `Único`. Sold-out sizes are present with `stockQuantity: 0`; strike them through rather than hiding them.',
  })
  variants: ProductVariantResponse[];

  @ApiProperty({ type: [ProductCategoryResponse] })
  categories: ProductCategoryResponse[];

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class PaginatedProductsResponse {
  @ApiProperty({ type: [ProductResponse] })
  items: ProductResponse[];

  @ApiProperty({
    description: 'Total matching the filters, not the page size.',
    example: 137,
  })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ description: 'Clamped to 100.', example: 20 })
  perPage: number;
}
