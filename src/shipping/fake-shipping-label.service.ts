import { Injectable, Logger } from '@nestjs/common';

import type {
  LabelPurchaseInput,
  PurchasedLabel,
  ShippingLabelProvider,
} from './shipping-label.service';

/**
 * Fake shipping label generator used when MELHOR_ENVIO_TOKEN is not configured
 * in development or test environments.
 *
 * Produces deterministic, valid-looking tracking codes and sandbox PDF links
 * without calling any external network service.
 */
@Injectable()
export class FakeShippingLabelService implements ShippingLabelProvider {
  private readonly logger = new Logger(FakeShippingLabelService.name);

  purchase(input: LabelPurchaseInput): Promise<PurchasedLabel> {
    this.logger.warn(
      `FakeShippingLabelService: gerando etiqueta simulada para pedido ${input.orderId} (serviço ${input.serviceCode}).`,
    );

    const numericCode = Math.floor(100_000_000 + Math.random() * 900_000_000);
    const trackingCode = `BR${String(numericCode)}BR`;
    const melhorEnvioShipmentId = `fake_${input.orderId}`;
    const labelUrl = `https://sandbox.melhorenvio.com.br/labels/fake_${input.orderId}.pdf`;

    return Promise.resolve({
      melhorEnvioShipmentId,
      trackingCode,
      labelUrl,
    });
  }
}
