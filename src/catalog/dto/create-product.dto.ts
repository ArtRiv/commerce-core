import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  @ApiProperty({ maxLength: 200, example: 'Camiseta Azul' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  /** Omitted = generated from the name. Sent and taken = 409, never suffixed. */
  @ApiPropertyOptional({
    maxLength: 200,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    description:
      'Omit to generate one from the name, with a numeric suffix on collision. Send one that is taken and the answer is 409 — a caller who picked the slug wants that slug.',
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

  /** Integer cents, > 0 — the spec's money invariant, enforced at the door. */
  @ApiProperty({
    minimum: 1,
    description: 'Integer cents, greater than zero. Never a float.',
    example: 7990,
  })
  @IsInt()
  @Min(1)
  priceCents!: number;

  @ApiPropertyOptional({
    type: [String],
    maxItems: 20,
    description: 'Plain URLs — this API does not host images in v1.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUrl({ require_tld: false }, { each: true })
  imageUrls?: string[];

  @ApiPropertyOptional({
    enum: ProductStatus,
    default: ProductStatus.DRAFT,
    description:
      'Products are born DRAFT and stay off the storefront until ACTIVE.',
  })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @ApiPropertyOptional({ minimum: 0, default: 0, example: 42 })
  @IsOptional()
  @IsInt()
  @Min(0)
  stockQuantity?: number;

  /**
   * Unit weight in grams, for freight quoting. Optional: a product without one
   * is quoted at SHIPPING_DEFAULT_WEIGHT_GRAMS, which the store pays for if the
   * guess is low — so it is worth filling in.
   */
  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Unit weight in grams, used to price freight. Omit and quotes fall back to a configured default — which the store pays for when the guess is low, so it is worth filling in.',
    example: 180,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  weightGrams?: number;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: 50,
    description: 'Category ids. A product in no category is valid.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  categoryIds?: string[];
}
