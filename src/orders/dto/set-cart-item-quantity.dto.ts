import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

/** PATCH is absolute — "make it 5" — unlike POST /cart/items, which adds. */
export class SetCartItemQuantityDto {
  @ApiProperty({
    minimum: 1,
    maximum: 999,
    description:
      'The absolute quantity for this line. Zero is not valid — use DELETE to remove the line.',
    example: 5,
  })
  @IsInt()
  @Min(1)
  @Max(999)
  quantity: number;
}
