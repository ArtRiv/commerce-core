import { Injectable, Logger } from '@nestjs/common';

import type {
  ShippingOption,
  ShippingProvider,
  ShippingQuoteRequest,
} from './shipping-provider';

/**
 * Shipping provider that wraps a primary (real carrier) and a fallback
 * (offline freight table), routing requests through the primary and silently
 * catching any ServiceUnavailableException to return the fallback result.
 *
 * This keeps the checkout flow alive when Melhor Envio is unreachable: the
 * customer still gets options from the configured table, and the operator
 * sees a warning in the logs. Empty results from the primary (carrier does
 * not serve that destination) are NOT fallen back — that is a fact about the
 * address, not an outage, and the fallback is unlikely to serve it either.
 *
 * Usage: bound to the SHIPPING_PROVIDER token by ShippingModule when
 * MELHOR_ENVIO_TOKEN is set; the table provider is used directly otherwise.
 */
@Injectable()
export class HybridShippingProvider implements ShippingProvider {
  private readonly logger = new Logger(HybridShippingProvider.name);

  constructor(
    private readonly primary: ShippingProvider,
    private readonly fallback: ShippingProvider,
  ) {}

  async quote(request: ShippingQuoteRequest): Promise<ShippingOption[]> {
    try {
      const options = await this.primary.quote(request);
      return options;
    } catch (error: unknown) {
      this.logger.warn(
        `Transportadora principal indisponível — usando tabela offline: ${String(error)}`,
      );
      return this.fallback.quote(request);
    }
  }
}
