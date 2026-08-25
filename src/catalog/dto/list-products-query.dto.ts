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
import { PRODUCT_SORTS, type ProductSort } from '../products.service';

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

  /**
   * Ordering is the server's job: sorting a page is not sorting a catalogue.
   * Omitted means `newest`, the ordering this endpoint has always had.
   */
  @ApiPropertyOptional({
    enum: PRODUCT_SORTS,
    default: 'newest',
    description:
      'Ordering, applied before pagination. Omit for `newest` (createdAt desc), the historical default. Every ordering breaks ties on id so pages never repeat or drop an item.',
  })
  @IsOptional()
  @IsIn(PRODUCT_SORTS)
  sort?: ProductSort;

  /** Inclusive. Integer cents, like every other money field. */
  @ApiPropertyOptional({
    minimum: 0,
    description:
      'Inclusive lower bound, integer cents. Greater than `maxPriceCents` is a 400, not an empty list.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPriceCents?: number;

  /** Inclusive. Integer cents, like every other money field. */
  @ApiPropertyOptional({
    minimum: 0,
    description: 'Inclusive upper bound, integer cents.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPriceCents?: number;
}
