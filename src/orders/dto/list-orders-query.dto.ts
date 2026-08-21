import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Min } from 'class-validator';

import { OrderStatus } from '../../generated/prisma/enums';

/**
 * Everything a query string can say to GET /orders. Numbers need the explicit
 * @Type: query params arrive as strings and implicit conversion is off.
 */
export class ListOrdersQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** Values above 100 are clamped by the service, not rejected. */
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

  @ApiPropertyOptional({ enum: OrderStatus })
  @IsOptional()
  @IsIn(Object.values(OrderStatus))
  status?: OrderStatus;

  /**
   * Requires orders.read — the service 403s anyone else. A customer's
   * listing is always implicitly their own.
   */
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'REQUIRES the `orders.read` permission — without it this is a 403. A customer listing is always implicitly their own, with or without this.',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;
}
