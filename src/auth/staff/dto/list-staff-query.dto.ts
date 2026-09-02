import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEmail, IsInt, IsOptional, Min } from 'class-validator';

/**
 * The team listing, and the one lookup that reaches past it.
 *
 * See docs/specs/staff-management.md, invariant 4: without `email` this lists
 * staff — a non-default role, or at least one direct grant — and never plain
 * shoppers, whose directory is a different surface behind `customers.read`.
 */
export class ListStaffQueryDto {
  @ApiPropertyOptional({
    format: 'email',
    description:
      'Find one account by its **exact** address, staff or not. This is how somebody who is not yet staff is found in order to be promoted — they are not in the listing by definition, and the alternative would be reading their id out of the database.\n\nMatching is on equality, case-insensitively (the address is normalized the way registration normalizes it). There is no substring search, on purpose: that would turn this route into a way to enumerate the store’s customers.',
    example: 'novo.funcionario@example.com',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    default: 20,
    description: 'Values above 100 are clamped, not rejected.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  perPage?: number;
}
