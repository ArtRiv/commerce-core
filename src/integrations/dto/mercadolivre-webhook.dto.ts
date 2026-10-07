import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class MercadoLivreWebhookDto {
  @ApiProperty({
    description:
      'Tópico de notificação disparado pelo Mercado Livre (ex: orders_v2, orders, items).',
    example: 'orders_v2',
  })
  @IsNotEmpty()
  @IsString()
  topic: string;

  @ApiProperty({
    description:
      'Recurso modificado no Mercado Livre (ex: /orders/2000001234567890).',
    example: '/orders/2000001234567890',
  })
  @IsNotEmpty()
  @IsString()
  resource: string;

  @ApiProperty({
    description:
      'Identificador numérico do vendedor (usuário) no Mercado Livre.',
    example: 123456789,
  })
  @IsNotEmpty()
  @IsNumber()
  user_id: number;

  @ApiProperty({
    description: 'Identificador do aplicativo no Mercado Livre.',
    example: 987654321,
    required: false,
  })
  @IsOptional()
  @IsNumber()
  application_id?: number;

  @ApiProperty({
    description: 'Identificador único do evento no Mercado Livre.',
    example: 'evt_1234567890',
    required: false,
  })
  @IsOptional()
  @IsString()
  _id?: string;
}
