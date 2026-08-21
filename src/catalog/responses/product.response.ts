import { ApiProperty } from '@nestjs/swagger';

import { ProductStatus } from '../../generated/prisma/enums';
import { ProductCategoryResponse } from './category.response';

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
    description: 'Never negative. Checkout decrements it atomically.',
    example: 42,
  })
  stockQuantity: number;

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
