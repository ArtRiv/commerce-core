import { Logger, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BlingErpService } from './bling-erp.service';
import { ERP_SERVICE } from './erp-service';
import { NoOpErpService } from './no-op-erp.service';

/**
 * Resolves the ERP service implementation at boot.
 *
 * - BLING_API_KEY present → BlingErpService (real Bling API v3 integration).
 * - BLING_API_KEY absent  → NoOpErpService (logs a warning, does nothing).
 *
 * Unlike payment gateways, the ERP is not critical to checkout — a store can
 * operate without it (orders still get created and paid). The consequence of
 * missing config is delayed NF-e emission, not a broken purchase flow. For
 * this reason, missing credentials are a warning, not a boot failure.
 */
function resolveErpService(
  config: ConfigService,
): BlingErpService | NoOpErpService {
  const apiKey = config.get<string>('BLING_API_KEY')?.trim();

  if (!apiKey) {
    new Logger('ErpModule').warn(
      'BLING_API_KEY não configurado — exportação para o Bling ERP desativada (NoOpErpService). ' +
        'Pedidos pagos não serão enviados para emissão de NF-e.',
    );
    return new NoOpErpService();
  }

  new Logger('ErpModule').log(
    'Bling ERP v3 configurado — pedidos pagos serão exportados automaticamente.',
  );
  return new BlingErpService(config);
}

const erpServiceProvider: Provider = {
  provide: ERP_SERVICE,
  inject: [ConfigService],
  useFactory: resolveErpService,
};

/**
 * ERP/fiscal integration module.
 *
 * Owns the Bling API v3 adapter and nothing else. It follows the same token
 * pattern as PaymentsModule and ShippingModule: the ERP_SERVICE Symbol is the
 * only thing exported, and consumers (OrdersModule) import it without knowing
 * which concrete implementation is behind it.
 *
 * A leaf module — it never imports CatalogModule, OrdersModule or any domain
 * module. Mapping from a Prisma Order row to CanonicalOrder happens in the
 * caller (OrdersService), keeping the arrow orders → erp one-directional.
 */
@Module({
  providers: [erpServiceProvider],
  exports: [ERP_SERVICE],
})
export class ErpModule {}
