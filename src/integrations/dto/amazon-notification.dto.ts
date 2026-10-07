import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AmazonNotificationDto {
  @ApiPropertyOptional({
    description:
      'Tipo da notificação SP-API (ex: ORDER_CHANGE, MFN_ORDER_STATUS_CHANGE).',
    example: 'ORDER_CHANGE',
  })
  @IsOptional()
  @IsString()
  NotificationType?: string;

  @ApiPropertyOptional({
    description: 'Tipo da notificação em camelCase / EventBridge detail-type.',
    example: 'ORDER_CHANGE',
  })
  @IsOptional()
  @IsString()
  notificationType?: string;

  @ApiPropertyOptional({
    description:
      'Tipo de detalhe em eventos disparados via Amazon EventBridge.',
    example: 'Amazon Selling Partner Notification',
  })
  @IsOptional()
  @IsString()
  'detail-type'?: string;

  @ApiPropertyOptional({
    description: 'ID da conta ou seller de origem.',
    example: 'A21TJRUUN4KGV',
  })
  @IsOptional()
  @IsString()
  SellerId?: string;

  @ApiProperty({
    description:
      'Dados ou payload do evento da notificação (contém AmazonOrderId, status, etc.).',
  })
  @IsNotEmpty()
  Payload?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Payload em minúsculo / formato EventBridge detail.',
  })
  @IsOptional()
  payload?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Detail em eventos nativos do Amazon EventBridge.',
  })
  @IsOptional()
  detail?: Record<string, unknown>;
}
