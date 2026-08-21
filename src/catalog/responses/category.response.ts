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
