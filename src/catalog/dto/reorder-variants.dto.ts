import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/** An anti-nonsense bound, not a business rule. No product has 200 sizes. */
const MAX_VARIANTS = 200;

/**
 * The whole display order, restated.
 *
 * Not a partial move: a list with some of the sizes in it does not say where
 * the others are supposed to end up, and inventing an answer is how an
 * ordering quietly stops being the one the operator saw. Same shape of
 * decision as `categoryIds` on PATCH /products, which also replaces the set
 * rather than merging into it.
 */
export class ReorderVariantsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: MAX_VARIANTS,
    description:
      "**Exactly** this product's variants, in the order they should display — no repeats, none missing, none belonging to another product. Anything else is a 400 rather than a partial reorder.\n\n`position` becomes the index in this array, so the list you send is the list you get back.",
    example: [
      '3f1c0a5e-1d9b-4a1e-8c2f-6a0b7d5e4c31',
      '9b2d1e6f-2c8a-4b7d-9e3f-1a5c8d7b2e40',
    ],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_VARIANTS)
  @IsUUID('4', { each: true })
  variantIds!: string[];
}
