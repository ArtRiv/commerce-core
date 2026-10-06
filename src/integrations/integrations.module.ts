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

@Module({
  imports: [CatalogModule, ErpModule],
  controllers: [IntegrationsController],
  providers: [
    EncryptionService,
    MercadoLivreAuthService,
    MercadoLivreConnector,
    MercadoLivreSyncService,
    MercadoLivreWebhookService,
    IntegrationsService,
  ],
  exports: [
    EncryptionService,
    MercadoLivreAuthService,
    MercadoLivreConnector,
    MercadoLivreSyncService,
    MercadoLivreWebhookService,
    IntegrationsService,
  ],
})
export class IntegrationsModule {}
