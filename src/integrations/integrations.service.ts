import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AmazonAuthService } from './amazon/amazon-auth.service';
import { AmazonDppService } from './amazon/amazon-dpp.service';
import { AmazonSyncService } from './amazon/amazon-sync.service';
import { AmazonWebhookService } from './amazon/amazon-webhook.service';
import { MercadoLivreAuthService } from './mercadolivre/mercadolivre-auth.service';
import { MercadoLivreSyncService } from './mercadolivre/mercadolivre-sync.service';
import { MercadoLivreWebhookService } from './mercadolivre/mercadolivre-webhook.service';
import type {
  CatalogSyncResponse,
  DisconnectIntegrationResponse,
  IntegrationItemResponse,
  ListIntegrationsResponse,
} from './responses/integration.response';
import { ShopeeAuthService } from './shopee/shopee-auth.service';
import { ShopeeSyncService } from './shopee/shopee-sync.service';
import { ShopeeWebhookService } from './shopee/shopee-webhook.service';

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    public readonly meliAuth: MercadoLivreAuthService,
    public readonly meliSync: MercadoLivreSyncService,
    public readonly meliWebhook: MercadoLivreWebhookService,
    public readonly shopeeAuth: ShopeeAuthService,
    public readonly shopeeSync: ShopeeSyncService,
    public readonly shopeeWebhook: ShopeeWebhookService,
    public readonly amazonAuth: AmazonAuthService,
    public readonly amazonSync: AmazonSyncService,
    public readonly amazonWebhook: AmazonWebhookService,
    public readonly amazonDpp: AmazonDppService,
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
    const shopeeRow = existing.find((i) => i.provider === 'SHOPEE');
    const amazonRow = existing.find((i) => i.provider === 'AMAZON');

    const integrations: IntegrationItemResponse[] = [
      {
        provider: 'MERCADO_LIVRE',
        connected: meliRow?.status === 'ACTIVE',
        status: (meliRow ? meliRow.status : 'DISCONNECTED') as
          'ACTIVE' | 'DISCONNECTED' | 'ERROR',
        expiresAt: meliRow?.expiresAt ? meliRow.expiresAt.toISOString() : null,
        metadata: (meliRow?.metadata as Record<string, unknown> | null) ?? null,
      },
      {
        provider: 'SHOPEE',
        connected: shopeeRow?.status === 'ACTIVE',
        status: (shopeeRow ? shopeeRow.status : 'DISCONNECTED') as
          'ACTIVE' | 'DISCONNECTED' | 'ERROR',
        expiresAt: shopeeRow?.expiresAt
          ? shopeeRow.expiresAt.toISOString()
          : null,
        metadata:
          (shopeeRow?.metadata as Record<string, unknown> | null) ?? null,
      },
      {
        provider: 'AMAZON',
        connected: amazonRow?.status === 'ACTIVE',
        status: (amazonRow ? amazonRow.status : 'DISCONNECTED') as
          'ACTIVE' | 'DISCONNECTED' | 'ERROR',
        expiresAt: amazonRow?.expiresAt
          ? amazonRow.expiresAt.toISOString()
          : null,
        metadata:
          (amazonRow?.metadata as Record<string, unknown> | null) ?? null,
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

  /**
   * Dispara sincronização completa de catálogo com a Shopee.
   */
  async syncShopeeCatalog(tenantId = 'default'): Promise<CatalogSyncResponse> {
    const result = await this.shopeeSync.syncAllCatalog(tenantId);
    return {
      syncedProducts: result.syncedProducts,
      totalVariants: result.totalVariants,
    };
  }

  /**
   * Dispara sincronização completa de catálogo com a Amazon SP-API.
   */
  async syncAmazonCatalog(tenantId = 'default'): Promise<CatalogSyncResponse> {
    const result = await this.amazonSync.syncAllCatalog(tenantId);
    return {
      syncedProducts: result.syncedProducts,
      totalVariants: result.totalVariants,
    };
  }
}
