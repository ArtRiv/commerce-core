import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

import { ProductStatus } from '../../generated/prisma/enums';

/**
 * Everything a query string can say to GET /products. Numbers need the
 * explicit @Type: the global ValidationPipe transforms, but query params
 * arrive as strings and implicit conversion is off.
 */
export class ListProductsQueryDto {
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

  /** Category slug. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  /**
   * Requires products.read — the controller 403s anyone else before the
   * service ever sees it. 'all' means every status.
   */
  @IsOptional()
  @IsIn([...Object.values(ProductStatus), 'all'])
  status?: ProductStatus | 'all';
}
