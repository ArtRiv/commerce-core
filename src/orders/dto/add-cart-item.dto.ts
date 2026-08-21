import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsUUID, Max, Min } from 'class-validator';

export class AddCartItemDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Must exist and be ACTIVE, or the answer is 404.',
  })
  @IsUUID()
  productId: string;

  /**
   * Per-add cap, mirrored by the service's own check. 999 is an anti-nonsense
   * bound, not a business rule — real stock enforcement happens at checkout.
   */
  @ApiProperty({
    minimum: 1,
    maximum: 999,
    description:
      'How many to ADD. A product already in the cart has its quantity increased rather than duplicated. The 999 bound applies per request, not to the resulting line.',
    example: 2,
  })
  @IsInt()
  @Min(1)
  @Max(999)
  quantity: number;
}
