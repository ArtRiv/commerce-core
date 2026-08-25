import { ApiProperty } from '@nestjs/swagger';

export class CategoryResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Camisetas' })
  name: string;

  @ApiProperty({
    description: 'URL identity. Unique, generated from the name when omitted.',
    example: 'camisetas',
  })
  slug: string;

  @ApiProperty({ nullable: true, type: String, example: null })
  description: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  @ApiProperty({
    description:
      'How many ACTIVE products sit in this category. Counts what the storefront grid shows, so DRAFT and ARCHIVED are excluded even for a caller holding products.read. Zero, never null, for an empty category.',
    example: 5,
  })
  productCount: number;
}

/** The slice of a category that travels inside a product. */
export class ProductCategoryResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Camisetas' })
  name: string;

  @ApiProperty({ example: 'camisetas' })
  slug: string;
}
