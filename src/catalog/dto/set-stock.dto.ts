import { IsInt, Min } from 'class-validator';

/**
 * Absolute quantity — "the shelf holds N" after an inventory count, not a
 * delta. Relative adjustments are the sale path and belong to
 * StockService.decrement, which orders calls internally.
 */
export class SetStockDto {
  @IsInt()
  @Min(0)
  quantity!: number;
}
