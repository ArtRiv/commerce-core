import { ApiPropertyOptional } from '@nestjs/swagger';
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

  /** Category slug. */
  @ApiPropertyOptional({ description: 'Category slug.', example: 'camisetas' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  category?: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description:
      'Case-insensitive partial match on the name. Not a search engine.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  /**
   * Requires products.read — the controller 403s anyone else before the
   * service ever sees it. 'all' means every status.
   */
  @ApiPropertyOptional({
    enum: [...Object.values(ProductStatus), 'all'],
    description:
      'REQUIRES the `products.read` permission — without it this is a 403, not a silently ignored filter. `all` means every status.',
  })
  @IsOptional()
  @IsIn([...Object.values(ProductStatus), 'all'])
  status?: ProductStatus | 'all';
}
