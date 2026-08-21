import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { SLUG_PATTERN } from './create-product.dto';

export class CreateCategoryDto {
  @ApiProperty({ maxLength: 200, example: 'Camisetas' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  /** Omitted = generated from the name. Sent and taken = 409, never suffixed. */
  @ApiPropertyOptional({
    maxLength: 200,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    description:
      'Generated from the name when omitted; 409 when sent and already taken.',
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
