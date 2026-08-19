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

/** Lowercase alphanumerics separated by single hyphens — what slugify emits. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  /** Omitted = generated from the name. Sent and taken = 409, never suffixed. */
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

  /** Integer cents, > 0 — the spec's money invariant, enforced at the door. */
  @IsInt()
  @Min(1)
  priceCents!: number;

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

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  categoryIds?: string[];
}
