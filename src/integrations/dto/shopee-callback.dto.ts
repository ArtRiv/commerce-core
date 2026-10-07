import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class ShopeeCallbackDto {
  @ApiProperty({
    description:
      'Código de autorização temporário emitido pela Shopee Open Platform após consentimento.',
    example: 'sp_auth_code_987654321',
  })
  @IsNotEmpty({ message: 'O código de autorização é obrigatório.' })
  @IsString()
  code: string;

  @ApiProperty({
    description: 'Identificador numérico da loja (shop_id) na Shopee.',
    example: 654321,
  })
  @IsNotEmpty({ message: 'O ID da loja (shop_id) é obrigatório.' })
  @Type(() => Number)
  @IsNumber()
  shop_id: number;

  @ApiProperty({
    description:
      'Parâmetro state assinado com HMAC-SHA256 para prevenção de CSRF.',
    example:
      'eyJ0ZW5hbnRJZCI6ImRlZmF1bHQiLCJub25jZSI6ImFiY2RlZiIsInRpbWVzdGFtcCI6MTY5NjYwMDAwMDAwMCwic2lnIjoiMTIzNDU2In0',
    required: false,
  })
  @IsOptional()
  @IsString()
  state?: string;
}
