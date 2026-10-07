import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsOptional } from 'class-validator';

export class ShopeeWebhookDto {
  @ApiProperty({
    description: 'Identificador numérico da loja (shop_id) na Shopee.',
    example: 654321,
  })
  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  shop_id: number;

  @ApiProperty({
    description:
      'Código numérico do evento disparado pela Shopee (3 = Order Update, 2 = Item Update, 4 = Tracking Update).',
    example: 3,
  })
  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  code: number;

  @ApiProperty({
    description: 'Timestamp Unix (em segundos) do envio da notificação push.',
    example: 1696600000,
  })
  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  timestamp: number;

  @ApiProperty({
    description: 'Carga útil específica do evento (ex: ordersn, status, etc.).',
    example: {
      ordersn: '230928ABCDEF1234',
      status: 'READY_TO_SHIP',
      update_time: 1696600000,
    },
  })
  @IsOptional()
  data?: Record<string, unknown>;
}
