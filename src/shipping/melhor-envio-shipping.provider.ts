import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import type {
  ShippingOption,
  ShippingProvider,
  ShippingQuoteRequest,
} from './shipping-provider';
import { normalizePostalCode } from './shipping-table';

/**
 * Shape of one service returned by POST /v2/me/shipment/calculate.
 * Only the fields we actually use are typed; the rest are left unknown.
 */
interface MelhorEnvioService {
  id: number;
  name: string;
  price: string | null;
  custom_price: string | null;
  discount: string | null;
  currency: string;
  delivery_time: number;
  delivery_range: { min: number; max: number };
  custom_delivery_time: number;
  custom_delivery_range: { min: number; max: number };
  packages: unknown[];
  additional_services: {
    receipt: boolean;
    own_hand: boolean;
    collect: boolean;
  };
  company: {
    id: number;
    name: string;
    picture: string;
  };
  error?: string;
}

/**
 * Shipping provider backed by the Melhor Envio v2 API.
 *
 * Calculates real-time rates from carriers (Correios, Jadlog, Loggi and others)
 * registered in the merchant's Melhor Envio account. Packages are consolidated
 * into a single box using the maximum dimension of each axis across all items,
 * and weight is the sum of (physical weight × quantity) for each line.
 *
 * A service whose response contains an `error` field is silently skipped —
 * that means the carrier declined that destination/weight, not that the whole
 * call failed. A network failure or non-2xx response throws
 * ServiceUnavailableException, which the caller (HybridShippingProvider) may
 * catch and redirect to the offline table.
 */
@Injectable()
export class MelhorEnvioShippingProvider implements ShippingProvider {
  private readonly logger = new Logger(MelhorEnvioShippingProvider.name);

  /** Base URL — swappable for sandbox via MELHOR_ENVIO_BASE_URL env var. */
  constructor(
    private readonly token: string,
    private readonly originPostalCode: string,
    private readonly baseUrl: string,
  ) {}

  async quote(request: ShippingQuoteRequest): Promise<ShippingOption[]> {
    const destination = normalizePostalCode(request.destination.postalCode);
    if (!destination) {
      // Malformed CEP — a fact about the address, not a network error.
      return [];
    }

    const body = this.buildPayload(request, destination);

    let services: MelhorEnvioService[];
    try {
      const response = await fetch(`${this.baseUrl}/v2/me/shipment/calculate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // Required by Melhor Envio for user-agent identification.
          'User-Agent': 'Avesso Commerce Platform (contato@avesso.com.br)',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '(unreadable)');
        this.logger.error(
          `Melhor Envio calculate failed: HTTP ${String(response.status)} — ${text}`,
        );
        throw new ServiceUnavailableException(
          'A transportadora está temporariamente indisponível para cotação.',
        );
      }

      services = (await response.json()) as MelhorEnvioService[];
    } catch (error: unknown) {
      if (error instanceof ServiceUnavailableException) throw error;
      this.logger.error(`Melhor Envio network error: ${String(error)}`);
      throw new ServiceUnavailableException(
        'A transportadora está temporariamente indisponível para cotação.',
      );
    }

    return services
      .filter((svc) => !svc.error && svc.price !== null)
      .map((svc) => this.toOption(svc));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildPayload(
    request: ShippingQuoteRequest,
    destinationCep: string,
  ): Record<string, unknown> {
    // Consolidate all items into one box: max dimension on each axis,
    // total weight = sum of (weightGrams × quantity).
    let totalWeightKg = 0;
    let maxHeightCm = 2; // carrier minimums
    let maxWidthCm = 11;
    let maxLengthCm = 16;

    for (const item of request.items) {
      totalWeightKg += (item.weightGrams / 1000) * item.quantity;
      if (item.heightCm && item.heightCm > maxHeightCm)
        maxHeightCm = item.heightCm;
      if (item.widthCm && item.widthCm > maxWidthCm) maxWidthCm = item.widthCm;
      if (item.lengthCm && item.lengthCm > maxLengthCm)
        maxLengthCm = item.lengthCm;
    }

    // Melhor Envio requires at least 0.1 kg.
    const weight = Math.max(totalWeightKg, 0.1);

    const originCep = normalizePostalCode(this.originPostalCode) ?? '01001000';

    return {
      from: { postal_code: originCep },
      to: { postal_code: destinationCep },
      package: {
        height: Math.ceil(maxHeightCm),
        width: Math.ceil(maxWidthCm),
        length: Math.ceil(maxLengthCm),
        weight: parseFloat(weight.toFixed(3)),
      },
      options: {
        receipt: false,
        own_hand: false,
      },
    };
  }

  private toOption(svc: MelhorEnvioService): ShippingOption {
    const priceCents = Math.round(
      parseFloat(svc.custom_price ?? svc.price ?? '0') * 100,
    );
    const days =
      svc.custom_delivery_time > 0
        ? svc.custom_delivery_time
        : svc.delivery_time > 0
          ? svc.delivery_time
          : null;

    return {
      // Stable, namespaced code so the order record stays traceable.
      code: `melhorenvio.${String(svc.id)}`,
      label: `${svc.name} — ${svc.company.name}`,
      priceCents,
      estimatedDays: days,
      carrier: svc.company.name,
    };
  }
}
