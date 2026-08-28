import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * A rename, and nothing else.
 *
 * `label` is required rather than optional-like-a-PATCH because renaming is
 * the only thing this route does: an empty body would be a request with no
 * content, answered 200, which is worse than a 400.
 *
 * Position is deliberately NOT here. Letting a single variant move would
 * invite reordering built out of N requests, and N requests is where a
 * half-applied order comes from — PATCH /products/{id}/variants/order restates
 * the whole list in one transaction instead
 * (docs/specs/variant-management.md).
 */
export class RenameVariantDto {
  @ApiProperty({
    maxLength: 20,
    description:
      'The new label. Must be unique within the product — a label another size already holds is a 409. Renaming a size to what it already is does nothing and answers 200.\n\n**Placed orders are unaffected**: `OrderItem.variantLabel` is a snapshot taken at purchase. Carts are the opposite and equally deliberate — they hold no snapshot, so a cart line starts showing the new label immediately.',
    example: 'Médio',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  label!: string;
}
