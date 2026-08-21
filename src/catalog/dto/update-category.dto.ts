import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { SLUG_PATTERN } from './create-product.dto';

export class UpdateCategoryDto {
  @ApiPropertyOptional({ maxLength: 200, example: 'Camisetas' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    maxLength: 200,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    example: 'camisetas',
  })
  @IsOptional()
  @Matches(SLUG_PATTERN, {
    message: 'slug must be lowercase alphanumerics separated by hyphens',
  })
  @MaxLength(200)
  slug?: string;

  @ApiPropertyOptional({ maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;
}
