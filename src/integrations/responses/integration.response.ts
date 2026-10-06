import { ApiProperty } from '@nestjs/swagger';

export class IntegrationItemResponse {
  @ApiProperty({ example: 'MERCADO_LIVRE' })
  provider: string;

  @ApiProperty({ example: true })
  connected: boolean;

  @ApiProperty({ example: 'ACTIVE', enum: ['ACTIVE', 'DISCONNECTED', 'ERROR'] })
  status: 'ACTIVE' | 'DISCONNECTED' | 'ERROR';

  @ApiProperty({
    type: String,
    example: '2026-10-06T18:00:00.000Z',
    nullable: true,
  })
  expiresAt: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { userId: 123456, nickname: 'LOJA_OFICIAL_ML' },
    nullable: true,
  })
  metadata: Record<string, unknown> | null;
}

export class ListIntegrationsResponse {
  @ApiProperty({ type: [IntegrationItemResponse] })
  integrations: IntegrationItemResponse[];
}

export class AuthUrlResponse {
  @ApiProperty({
    example:
      'https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=123&redirect_uri=...',
  })
  url: string;
}

export class DisconnectIntegrationResponse {
  @ApiProperty({ example: true })
  disconnected: boolean;
}

export class CatalogSyncResponse {
  @ApiProperty({ example: 5 })
  syncedProducts: number;

  @ApiProperty({ example: 12 })
  totalVariants: number;
}

export class WebhookAckResponse {
  @ApiProperty({ example: true })
  received: boolean;

  @ApiProperty({ example: 'order_imported_successfully' })
  action: string;
}
