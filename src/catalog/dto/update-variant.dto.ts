import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateVariantDto {
  @ApiPropertyOptional({
    maxLength: 20,
    description:
      'The new label. Must be unique within the product — a label another size already holds is a 409.',
    example: 'Médio',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  label?: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    description: 'Height in centimetres for cubic freight quoting.',
    example: 10,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  heightCm?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    description: 'Width in centimetres for cubic freight quoting.',
    example: 15,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  widthCm?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    description: 'Length in centimetres for cubic freight quoting.',
    example: 20,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  lengthCm?: number | null;
}
