import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

/**
 * Turns the two strings a query string can carry into a real boolean, and
 * refuses everything else.
 *
 * `@Type(() => Boolean)` would be the obvious choice and is a trap:
 * `Boolean('false')` is `true`, so the value that asks for the protection
 * would be the value that switches it off. Anything unrecognised is passed
 * through untouched so @IsBoolean rejects it with a 400 — never guessed at.
 */
const strictBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true' || value === true) {
    return true;
  }
  if (value === 'false' || value === false) {
    return false;
  }
  return value;
};

/**
 * The confirmation for a destructive removal, in two halves that only mean
 * something together (docs/specs/variant-management.md).
 *
 * The service refuses either half sent alone: an authorisation with no
 * reviewed impact is signed once and good for any amount of damage, and a
 * reviewed impact with no authorisation asks for nothing.
 */
export class RemoveVariantQueryDto {
  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Authorises deleting the cart lines of everyone holding this size. Omit it and a size sitting in any cart is refused with a 409 carrying the count.\n\nMust be sent together with `expectedCartLineCount`. Named for what it does rather than `force`, because it cannot be ticked without reading the consequence.',
    example: true,
  })
  @IsOptional()
  @Transform(strictBoolean)
  @IsBoolean()
  discardCartLines?: boolean;

  @ApiPropertyOptional({
    minimum: 0,
    description:
      'The `cartLineCount` from the 409 you just reviewed. The count is taken again under a row lock inside the deletion transaction, and **any** difference — in either direction — aborts the whole thing with a 409 carrying the current number, changing nothing. A fourth cart arriving between the warning and the confirmation is therefore never deleted unseen.',
    example: 3,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedCartLineCount?: number;
}
