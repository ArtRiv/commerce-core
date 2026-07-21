import { IsInt, IsUUID, Max, Min } from 'class-validator';

export class AddCartItemDto {
  @IsUUID()
  productId: string;

  /**
   * Per-add cap, mirrored by the service's own check. 999 is an anti-nonsense
   * bound, not a business rule — real stock enforcement happens at checkout.
   */
  @IsInt()
  @Min(1)
  @Max(999)
  quantity: number;
}
