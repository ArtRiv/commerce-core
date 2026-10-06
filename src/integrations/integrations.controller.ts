import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PERMISSIONS } from '../auth/authz/permissions';
import { RequirePermissions } from '../auth/authz/require-permissions.decorator';
import { Public } from '../auth/public.decorator';
import { MercadoLivreCallbackDto } from './dto/mercadolivre-callback.dto';
import { MercadoLivreWebhookDto } from './dto/mercadolivre-webhook.dto';
import { IntegrationsService } from './integrations.service';
import {
  AuthUrlResponse,
  CatalogSyncResponse,
  DisconnectIntegrationResponse,
  IntegrationItemResponse,
  ListIntegrationsResponse,
  WebhookAckResponse,
} from './responses/integration.response';

@ApiTags('integrations')
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.INTEGRATIONS_READ)
  @ApiOperation({
    summary: 'Lista os canais de integração e marketplaces configurados.',
  })
  @ApiOkResponse({ type: ListIntegrationsResponse })
  async list(): Promise<ListIntegrationsResponse> {
    return this.integrationsService.listIntegrations('default');
  }

  @Get('mercadolivre/auth-url')
  @RequirePermissions(PERMISSIONS.INTEGRATIONS_MANAGE)
  @ApiOperation({
    summary:
      'Gera URL de autorização OAuth 2.0 do Mercado Livre com state HMAC-SHA256.',
  })
  @ApiOkResponse({ type: AuthUrlResponse })
  getMeliAuthUrl(): AuthUrlResponse {
    const url =
      this.integrationsService.meliAuth.getAuthorizationUrl('default');
    return { url };
  }

  @Post('mercadolivre/callback')
  @RequirePermissions(PERMISSIONS.INTEGRATIONS_MANAGE)
  @ApiOperation({
    summary:
      'Troca código de autorização OAuth por tokens e ativa integração com Mercado Livre.',
  })
  @ApiOkResponse({ type: IntegrationItemResponse })
  async meliCallback(
    @Body() dto: MercadoLivreCallbackDto,
  ): Promise<IntegrationItemResponse> {
    const result =
      await this.integrationsService.meliAuth.exchangeAuthorizationCode(
        dto.code,
        dto.state,
      );

    return {
      provider: 'MERCADO_LIVRE',
      connected: true,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 21600 * 1000).toISOString(),
      metadata: {
        nickname: result.nickname,
      },
    };
  }

  @Post('mercadolivre/disconnect')
  @RequirePermissions(PERMISSIONS.INTEGRATIONS_MANAGE)
  @ApiOperation({
    summary: 'Desconecta e revoga credenciais da integração com Mercado Livre.',
  })
  @ApiOkResponse({ type: DisconnectIntegrationResponse })
  async disconnectMeli(): Promise<DisconnectIntegrationResponse> {
    return this.integrationsService.disconnect('MERCADO_LIVRE', 'default');
  }

  @Post('mercadolivre/sync')
  @RequirePermissions(PERMISSIONS.INTEGRATIONS_MANAGE)
  @ApiOperation({
    summary:
      'Dispara sincronização manual de catálogo e estoque para o Mercado Livre.',
  })
  @ApiOkResponse({ type: CatalogSyncResponse })
  async syncMeliCatalog(): Promise<CatalogSyncResponse> {
    return this.integrationsService.syncCatalog('default');
  }

  @Public()
  @Post('mercadolivre/webhook')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Receptor público de webhooks do Mercado Livre para tópicos orders e items.',
  })
  @ApiOkResponse({ type: WebhookAckResponse })
  async meliWebhook(
    @Body() dto: MercadoLivreWebhookDto,
  ): Promise<WebhookAckResponse> {
    const result =
      await this.integrationsService.meliWebhook.processNotification(
        dto,
        'default',
      );
    return {
      received: true,
      action: result.action,
    };
  }
}
