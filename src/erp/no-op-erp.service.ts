import { Injectable, Logger } from '@nestjs/common';

import type {
  CanonicalOrder,
  ErpExportResult,
  ErpService,
} from './erp-service';

/**
 * No-op ERP service used when BLING_API_KEY is not set.
 *
 * In development/test environments, skipping the Bling export is expected —
 * there are no real credentials to use. This implementation logs a warning so
 * the absence is visible in the output, but otherwise does nothing. It never
 * throws, so OrdersService.markPaid() continues normally.
 */
@Injectable()
export class NoOpErpService implements ErpService {
  private readonly logger = new Logger(NoOpErpService.name);

  exportOrder(order: CanonicalOrder): Promise<ErpExportResult> {
    this.logger.warn(
      `ERP export ignorado para o pedido ${order.id} — BLING_API_KEY não configurado.`,
    );
    // Return a sentinel so the caller does not have to handle null separately.
    return Promise.resolve({ erpOrderId: 'noop' });
  }
}
