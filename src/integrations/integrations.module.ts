import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { ErpModule } from '../erp/erp.module';
import { EncryptionService } from './crypto/encryption.service';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { MercadoLivreAuthService } from './mercadolivre/mercadolivre-auth.service';
import { MercadoLivreConnector } from './mercadolivre/mercadolivre-connector';
import { MercadoLivreSyncService } from './mercadolivre/mercadolivre-sync.service';
import { MercadoLivreWebhookService } from './mercadolivre/mercadolivre-webhook.service';
import { ShopeeAuthService } from './shopee/shopee-auth.service';
import { ShopeeCategoryMappingService } from './shopee/shopee-category-mapping.service';
import { ShopeeConnector } from './shopee/shopee-connector';
import { ShopeeSyncService } from './shopee/shopee-sync.service';
import { ShopeeWebhookService } from './shopee/shopee-webhook.service';

@Module({
  imports: [CatalogModule, ErpModule],
  controllers: [IntegrationsController],
  providers: [
    EncryptionService,
    MercadoLivreAuthService,
    MercadoLivreConnector,
    MercadoLivreSyncService,
    MercadoLivreWebhookService,
    ShopeeAuthService,
    ShopeeCategoryMappingService,
    ShopeeConnector,
    ShopeeSyncService,
    ShopeeWebhookService,
    IntegrationsService,
  ],
  exports: [
    EncryptionService,
    MercadoLivreAuthService,
    MercadoLivreConnector,
    MercadoLivreSyncService,
    MercadoLivreWebhookService,
    ShopeeAuthService,
    ShopeeCategoryMappingService,
    ShopeeConnector,
    ShopeeSyncService,
    ShopeeWebhookService,
    IntegrationsService,
  ],
})
export class IntegrationsModule {}
