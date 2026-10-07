import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AmazonCallbackDto {
  @ApiPropertyOptional({
    description:
      'Código de autorização OAuth 2.0 retornado pela Amazon (spapi_oauth_code).',
    example: 'ANzUvgZcKjV...',
  })
  @IsOptional()
  @IsString()
  spapi_oauth_code?: string;

  @ApiPropertyOptional({
    description: 'Código de autorização (alias convencional code).',
    example: 'ANzUvgZcKjV...',
  })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiProperty({
    description:
      'Identificador do vendedor na Amazon (Selling Partner ID / Merchant ID).',
    example: 'A21TJRUUN4KGV',
  })
  @IsNotEmpty()
  @IsString()
  selling_partner_id: string;

  @ApiProperty({
    description:
      'Parâmetro state assinado com HMAC-SHA256 para prevenção de CSRF.',
    example: 'eyJ0ZW5hbnRJZCI6ImRlZmF1bHQiLCJub25jZSI6Ii...}',
  })
  @IsNotEmpty()
  @IsString()
  state: string;
}
