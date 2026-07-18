import { IsInt, Max, Min } from 'class-validator';

/** PATCH is absolute — "make it 5" — unlike POST /cart/items, which adds. */
export class SetCartItemQuantityDto {
  @IsInt()
  @Min(1)
  @Max(999)
  quantity: number;
}
