import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

import { ProductStatus } from '../../generated/prisma/enums';
import { SLUG_PATTERN } from './create-product.dto';

/**
 * Every field of CreateProductDto, each optional. Spelled out rather than
 * derived with PartialType because @nestjs/mapped-types is not a dependency
 * of this project, and one small DTO does not justify adding it.
 */
export class UpdateProductDto {
  @ApiPropertyOptional({ maxLength: 200, example: 'Camiseta Azul' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    maxLength: 200,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    example: 'camiseta-azul',
  })
  @IsOptional()
  @Matches(SLUG_PATTERN, {
    message: 'slug must be lowercase alphanumerics separated by hyphens',
  })
  @MaxLength(200)
  slug?: string;

  @ApiPropertyOptional({ maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ minimum: 1, example: 7990 })
  @IsOptional()
  @IsInt()
  @Min(1)
  priceCents?: number;

  @ApiPropertyOptional({ type: [String], maxItems: 20 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUrl({ require_tld: false }, { each: true })
  imageUrls?: string[];

  @ApiPropertyOptional({
    enum: ProductStatus,
    description:
      'This is how a product reaches ACTIVE — there is no separate publish route.',
  })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @ApiPropertyOptional({ minimum: 0, example: 42 })
  @IsOptional()
  @IsInt()
  @Min(0)
  stockQuantity?: number;

  /**
   * Unit weight in grams, for freight quoting. Optional: a product without one
   * is quoted at SHIPPING_DEFAULT_WEIGHT_GRAMS, which the store pays for if the
   * guess is low — so it is worth filling in.
   */
  @ApiPropertyOptional({ minimum: 1, example: 180 })
  @IsOptional()
  @IsInt()
  @Min(1)
  weightGrams?: number;

  /** Absent = leave categories alone. Present = the full new set. */
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: 50,
    description:
      'Absent leaves the associations alone; present REPLACES the whole set.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  categoryIds?: string[];
}
