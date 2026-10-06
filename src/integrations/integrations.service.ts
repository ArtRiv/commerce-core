import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { MercadoLivreAuthService } from './mercadolivre/mercadolivre-auth.service';
import { MercadoLivreSyncService } from './mercadolivre/mercadolivre-sync.service';
import { MercadoLivreWebhookService } from './mercadolivre/mercadolivre-webhook.service';
import type {
  CatalogSyncResponse,
  DisconnectIntegrationResponse,
  IntegrationItemResponse,
  ListIntegrationsResponse,
} from './responses/integration.response';

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    public readonly meliAuth: MercadoLivreAuthService,
    public readonly meliSync: MercadoLivreSyncService,
    public readonly meliWebhook: MercadoLivreWebhookService,
  ) {}

  /**
   * Lista todos os canais de marketplace configurados para o tenant.
   */
  async listIntegrations(
    tenantId = 'default',
  ): Promise<ListIntegrationsResponse> {
    const existing = await this.prisma.tenantIntegration.findMany({
      where: { tenantId },
    });

    const meliRow = existing.find((i) => i.provider === 'MERCADO_LIVRE');

    const integrations: IntegrationItemResponse[] = [
      {
        provider: 'MERCADO_LIVRE',
        connected: meliRow?.status === 'ACTIVE',
        status: (meliRow ? meliRow.status : 'DISCONNECTED') as
          'ACTIVE' | 'DISCONNECTED' | 'ERROR',
        expiresAt: meliRow?.expiresAt ? meliRow.expiresAt.toISOString() : null,
        metadata: (meliRow?.metadata as Record<string, unknown> | null) ?? null,
      },
    ];

    return { integrations };
  }

  /**
   * Desconecta um canal específico limpando credenciais e marcando como DISCONNECTED.
   */
  async disconnect(
    provider: string,
    tenantId = 'default',
  ): Promise<DisconnectIntegrationResponse> {
    await this.prisma.tenantIntegration.updateMany({
      where: { tenantId, provider },
      data: {
        status: 'DISCONNECTED',
        credentialsEncrypted: '',
        expiresAt: null,
        updatedAt: new Date(),
      },
    });

    this.logger.log(
      `Integração ${provider} desconectada para o tenant ${tenantId}.`,
    );
    return { disconnected: true };
  }

  /**
   * Dispara sincronização completa de catálogo com o Mercado Livre.
   */
  async syncCatalog(tenantId = 'default'): Promise<CatalogSyncResponse> {
    const result = await this.meliSync.syncAllCatalog(tenantId);
    return {
      syncedProducts: result.syncedProducts,
      totalVariants: result.totalVariants,
    };
  }
}
