import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Min } from 'class-validator';

import { OrderStatus } from '../../generated/prisma/enums';

/**
 * Everything a query string can say to GET /orders. Numbers need the explicit
 * @Type: query params arrive as strings and implicit conversion is off.
 */
export class ListOrdersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** Values above 100 are clamped by the service, not rejected. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  perPage?: number;

  @IsOptional()
  @IsIn(Object.values(OrderStatus))
  status?: OrderStatus;

  /**
   * Requires orders.read — the service 403s anyone else. A customer's
   * listing is always implicitly their own.
   */
  @IsOptional()
  @IsUUID()
  userId?: string;
}
