import { Injectable, Logger } from '@nestjs/common';

import { normalizePostalCode } from './shipping-table';

/**
 * Everything needed to purchase a shipping label for a dispatched order.
 * The caller provides denormalized order data so this service never touches
 * the database — it lives in `shipping` and the database is owned by `orders`.
 */
export interface LabelPurchaseInput {
  /** Our internal order id — stamped as the order reference on the label. */
  orderId: string;
  /** The Melhor Envio service code selected by the operator (e.g. "melhorenvio.1"). */
  serviceCode: string;
  /** Weight of the consolidated parcel, in grams. */
  totalWeightGrams: number;
  /** Parcel dimensions in centimetres. */
  heightCm: number;
  widthCm: number;
  lengthCm: number;
  /** Declared value of the contents in Brazilian Reais (not cents). */
  insuranceValueBrl: number;
  origin: {
    postalCode: string;
    name: string;
    phone: string;
  };
  destination: {
    postalCode: string;
    name: string;
    address: string;
    number: string;
    complement: string;
    neighborhood: string;
    city: string;
    stateAbbr: string;
  };
}

export interface PurchasedLabel {
  /** Melhor Envio shipment id — used to generate and download the label PDF. */
  melhorEnvioShipmentId: string;
  /** Carrier tracking code stamped on the label. */
  trackingCode: string;
  /** Temporary URL to download the label PDF. Typically valid for ~30 minutes. */
  labelUrl: string;
}

export interface ShippingLabelProvider {
  purchase(input: LabelPurchaseInput): Promise<PurchasedLabel>;
}

// ---------------------------------------------------------------------------
// Internal Melhor Envio response shapes (minimal typing — only used fields).
// ---------------------------------------------------------------------------

interface MeCartResponse {
  id: number;
}

interface MeCheckoutOrder {
  id: number;
  tracking: string;
}

interface MeCheckoutResponse {
  purchase: {
    id: number;
    orders: (MeCheckoutOrder | undefined)[];
  };
}

interface MeGenerateResponse {
  url?: string;
}

/**
 * Purchases a shipping label from Melhor Envio in three API calls:
 *  1. POST /v2/me/cart      — add a shipment to the ME cart.
 *  2. POST /v2/me/shipment/checkout — purchase all items in the cart.
 *  3. GET  /v2/me/shipment/{id}/generate?mode=private — get the label PDF URL.
 *
 * This service is intentionally stateless and has no database access. All
 * data comes in via LabelPurchaseInput, and all results are returned in
 * PurchasedLabel. Persisting the result (trackingCode, labelUrl) is the
 * caller's responsibility (OrdersService).
 */
@Injectable()
export class ShippingLabelService implements ShippingLabelProvider {
  private readonly logger = new Logger(ShippingLabelService.name);

  constructor(
    private readonly token: string,
    private readonly baseUrl: string,
  ) {}

  async purchase(input: LabelPurchaseInput): Promise<PurchasedLabel> {
    const serviceId = this.parseServiceId(input.serviceCode);

    // Step 1 — Add to cart.
    const cartItem = await this.addToCart(input, serviceId);

    // Step 2 — Purchase (checkout) the cart.
    const shipment = await this.checkout(cartItem.id, input.orderId);

    // Step 3 — Generate label PDF URL.
    const labelUrl = await this.generateLabel(shipment.id);

    return {
      melhorEnvioShipmentId: String(shipment.id),
      trackingCode: shipment.tracking,
      labelUrl,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: API calls
  // ---------------------------------------------------------------------------

  private async addToCart(
    input: LabelPurchaseInput,
    serviceId: number,
  ): Promise<MeCartResponse> {
    const originCep = normalizePostalCode(input.origin.postalCode) ?? '';
    const destCep = normalizePostalCode(input.destination.postalCode) ?? '';

    const body = {
      service: serviceId,
      agency: null,
      from: {
        name: input.origin.name,
        phone: input.origin.phone,
        postal_code: originCep,
      },
      to: {
        name: input.destination.name,
        postal_code: destCep,
        address: input.destination.address,
        number: input.destination.number,
        complement: input.destination.complement,
        district: input.destination.neighborhood,
        city: input.destination.city,
        state_abbr: input.destination.stateAbbr,
      },
      products: [
        {
          name: `Pedido ${input.orderId}`,
          quantity: 1,
          unitary_value: input.insuranceValueBrl,
        },
      ],
      volumes: [
        {
          height: Math.ceil(input.heightCm),
          width: Math.ceil(input.widthCm),
          length: Math.ceil(input.lengthCm),
          weight: parseFloat((input.totalWeightGrams / 1000).toFixed(3)),
        },
      ],
      options: {
        insurance_value: input.insuranceValueBrl,
        receipt: false,
        own_hand: false,
        reverse: false,
        non_commercial: false,
        invoice: { key: '' },
        tags: [{ tag: input.orderId, url: null }],
      },
    };

    return this.post<MeCartResponse>('/v2/me/cart', body);
  }

  private async checkout(
    cartItemId: number,
    orderId: string,
  ): Promise<MeCheckoutOrder> {
    const body = { orders: [cartItemId] };
    const result = await this.post<MeCheckoutResponse>(
      '/v2/me/shipment/checkout',
      body,
    );

    const order: MeCheckoutOrder | undefined = result.purchase.orders[0];
    if (!order) {
      throw new Error(
        `Checkout do Melhor Envio não retornou um pedido para o carrinho ${String(cartItemId)} (pedido ${orderId})`,
      );
    }
    return order;
  }

  private async generateLabel(shipmentId: number): Promise<string> {
    const result = await this.get<MeGenerateResponse>(
      `/v2/me/shipment/${String(shipmentId)}/generate?mode=private`,
    );
    if (!result.url) {
      throw new Error(
        `Melhor Envio não retornou URL de etiqueta para o envio ${String(shipmentId)}`,
      );
    }
    return result.url;
  }

  // ---------------------------------------------------------------------------
  // Private: HTTP helpers
  // ---------------------------------------------------------------------------

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '(unreadable)');
      this.logger.error(
        `Melhor Envio POST ${path} failed: HTTP ${String(response.status)} — ${text}`,
      );
      throw new Error(`Melhor Envio ${path}: HTTP ${String(response.status)}`);
    }

    return response.json() as Promise<T>;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '(unreadable)');
      this.logger.error(
        `Melhor Envio GET ${path} failed: HTTP ${String(response.status)} — ${text}`,
      );
      throw new Error(`Melhor Envio ${path}: HTTP ${String(response.status)}`);
    }

    return response.json() as Promise<T>;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'Avesso Commerce Platform (contato@avesso.com.br)',
    };
  }

  // ---------------------------------------------------------------------------
  // Private: utilities
  // ---------------------------------------------------------------------------

  /**
   * Extracts the numeric Melhor Envio service id from a namespaced code.
   * "melhorenvio.1" → 1. Throws if the format is unexpected.
   */
  private parseServiceId(code: string): number {
    const parts = code.split('.');
    const id =
      parts.length === 2 && parts[0] === 'melhorenvio' ? Number(parts[1]) : NaN;

    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(
        `Código de serviço inválido: "${code}". Formato esperado: "melhorenvio.{id}".`,
      );
    }

    return id;
  }
}

/** Symbol for DI injection — optional service, not always bound. */
export const SHIPPING_LABEL_SERVICE = Symbol('SHIPPING_LABEL_SERVICE');
