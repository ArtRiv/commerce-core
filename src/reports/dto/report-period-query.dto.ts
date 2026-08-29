import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, Min } from 'class-validator';

/**
 * The window three of the four reports take, in one class so a period cannot
 * come to mean slightly different things per route.
 *
 * Half-open — `from` inclusive, `to` exclusive — which is what stops August
 * and September counting the same order twice when a panel asks for both.
 * See docs/specs/reports.md, invariant 3.
 */
export class ReportPeriodQueryDto {
  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Start of the window, **inclusive**. ISO-8601; a bare date is read as midnight UTC. Omit it for 30 days before `to`.',
    example: '2026-08-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'End of the window, **exclusive** — so two adjacent months never count the same order twice. Omit it for now.\n\nA `from` at or after `to` is a 400, not an empty list: an impossible window is the caller’s bug, and `[]` would read as "nothing matched".',
    example: '2026-09-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  to?: string;
}

/** The window plus the pagination envelope the rest of the API already uses. */
export class PaginatedPeriodQueryDto extends ReportPeriodQueryDto {
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
