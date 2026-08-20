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
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @Matches(SLUG_PATTERN, {
    message: 'slug must be lowercase alphanumerics separated by hyphens',
  })
  @MaxLength(200)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  priceCents?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUrl({ require_tld: false }, { each: true })
  imageUrls?: string[];

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsOptional()
  @IsInt()
  @Min(0)
  stockQuantity?: number;

  /**
   * Unit weight in grams, for freight quoting. Optional: a product without one
   * is quoted at SHIPPING_DEFAULT_WEIGHT_GRAMS, which the store pays for if the
   * guess is low — so it is worth filling in.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  weightGrams?: number;

  /** Absent = leave categories alone. Present = the full new set. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  categoryIds?: string[];
}
