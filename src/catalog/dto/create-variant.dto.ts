import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Cap on positions, so an ordering column cannot be used to store a number. */
const MAX_POSITION = 999;

/**
 * One size, on the way in.
 *
 * `label` is free text rather than an enum: shoe numbering and ring sizes are
 * the same idea in another alphabet, and an enum would mean a migration per
 * new store (docs/specs/product-variants.md).
 */
export class CreateVariantDto {
  @ApiProperty({
    maxLength: 20,
    description:
      'What the customer picks — `P`, `M`, `G`, `GG`, `XGG`, `Único`, `42`. Must be unique within the product.',
    example: 'M',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  label!: string;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: MAX_POSITION,
    description:
      "Display order. Omit and it becomes this variant's index in the list, which is why sending P, M, G, GG, XGG in order simply works. Never sorted alphabetically — that would put GG before M.",
    example: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_POSITION)
  position?: number;

  @ApiPropertyOptional({
    minimum: 0,
    default: 0,
    description:
      'Stock for this size. Zero is a legitimate starting point — the size exists and has none left.',
    example: 12,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  stockQuantity?: number;
}
