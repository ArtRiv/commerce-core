import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsUUID, Max, Min } from 'class-validator';

export class AddCartItemDto {
  /**
   * A VARIANT, not a product. A bare product id is not buyable: it does not
   * say which size, and picking one on the caller's behalf would be wrong on
   * every shirt with more than one (docs/specs/product-variants.md).
   */
  @ApiProperty({
    format: 'uuid',
    description:
      'The **variant** (size) to add — from `ProductResponse.variants[].id`. Its product must exist and be ACTIVE, or the answer is 404. A product id is not accepted: it does not say which size.',
  })
  @IsUUID()
  variantId: string;

  /**
   * Per-add cap, mirrored by the service's own check. 999 is an anti-nonsense
   * bound, not a business rule — real stock enforcement happens at checkout.
   */
  @ApiProperty({
    minimum: 1,
    maximum: 999,
    description:
      'How many to ADD. The same variant already in the cart has its quantity increased rather than duplicated; a DIFFERENT size of the same product is a separate line. The 999 bound applies per request, not to the resulting line.',
    example: 2,
  })
  @IsInt()
  @Min(1)
  @Max(999)
  quantity: number;
}
