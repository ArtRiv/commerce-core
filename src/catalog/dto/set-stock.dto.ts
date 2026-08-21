import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

/**
 * Absolute quantity — "the shelf holds N" after an inventory count, not a
 * delta. Relative adjustments are the sale path and belong to
 * StockService.decrement, which orders calls internally.
 */
export class SetStockDto {
  @ApiProperty({
    minimum: 0,
    description:
      'The absolute count on the shelf, not a delta. Selling is the other path — checkout decrements atomically on its own.',
    example: 12,
  })
  @IsInt()
  @Min(0)
  quantity!: number;
}
