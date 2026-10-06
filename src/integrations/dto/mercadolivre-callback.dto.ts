import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class MercadoLivreCallbackDto {
  @ApiProperty({
    description:
      'Código de autorização temporário emitido pelo Mercado Livre após consentimento.',
    example: 'TG-65f1234567890abcdef',
  })
  @IsNotEmpty({ message: 'O código de autorização é obrigatório.' })
  @IsString()
  code: string;

  @ApiProperty({
    description:
      'Parâmetro state assinado com HMAC-SHA256 para prevenção de CSRF.',
    example:
      'eyJ0ZW5hbnRJZCI6ImRlZmF1bHQiLCJub25jZSI6ImFiY2RlZiIsInRpbWVzdGFtcCI6MTY5NjYwMDAwMDAwMCwic2lnIjoiMTIzNDU2In0',
  })
  @IsNotEmpty({ message: 'O state de autenticação é obrigatório.' })
  @IsString()
  state: string;
}
