import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  CreatePaymentInput,
  DomainOutcome,
  PaymentEvent,
  PaymentProvider,
  PaymentSession,
  SessionLookup,
  WebhookHeaders,
} from './payment-provider';

/** How long a PIX charge stays payable before Asaas marks it OVERDUE. */
const PIX_EXPIRATION_HOURS = 24;

/** Prefix that identifies an Asaas payment reference in the hybrid router. */
export const ASAAS_PREFIX = 'asaas_';

/**
 * Header the Asaas platform sends with every webhook notification.
 * Its value must equal ASAAS_WEBHOOK_SECRET to be considered authentic.
 */
const ASAAS_TOKEN_HEADER = 'asaas-access-token';

/**
 * Asaas PIX payment adapter.
 *
 * Handles the full lifecycle of a PIX charge via the Asaas v3 REST API:
 * customer creation/lookup, charge generation, QR Code retrieval, status
 * polling and cancellation. Webhook events are authenticated by comparing
 * the `asaas-access-token` header against ASAAS_WEBHOOK_SECRET using a
 * timing-safe comparison.
 *
 * This provider is only ever reached when `CreatePaymentInput.method === 'PIX'`.
 * The HybridPaymentProvider handles the routing decision.
 */
@Injectable()
export class AsaasPaymentProvider implements PaymentProvider {
  private readonly logger = new Logger(AsaasPaymentProvider.name);
  private readonly apiKey: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.apiKey = config.getOrThrow<string>('ASAAS_API_KEY');
    this.webhookSecret = config.getOrThrow<string>('ASAAS_WEBHOOK_SECRET');
    // Sandbox: https://sandbox.asaas.com/api/v3
    // Production: https://api.asaas.com/v3
    this.baseUrl =
      config.get<string>('ASAAS_BASE_URL') ?? 'https://api.asaas.com/v3';
  }

  async createPayment({
    orderId,
    amountCents,
    buyer,
  }: CreatePaymentInput): Promise<PaymentSession> {
    // Asaas requires a customer record. We use the buyer's email as the external
    // reference so we can look them up on subsequent orders.
    const customerId = buyer?.email
      ? await this.ensureCustomer(buyer)
      : undefined;

    const amount = amountCents / 100;

    const dueDate = new Date();
    dueDate.setHours(dueDate.getHours() + PIX_EXPIRATION_HOURS);
    const dueDateStr = dueDate.toISOString().split('T')[0]; // YYYY-MM-DD

    const body: Record<string, unknown> = {
      billingType: 'PIX',
      value: amount,
      dueDate: dueDateStr,
      description: `Pedido ${orderId}`,
      externalReference: orderId,
    };

    if (customerId) {
      body.customer = customerId;
    } else if (buyer?.email) {
      // Asaas allows anonymous charges with a name — fall back when creation fails.
      body.name = buyer.name ?? buyer.email;
      body.cpfCnpj = buyer.document ?? undefined;
    }

    const charge = await this.request<AsaasCharge>('POST', '/payments', body);

    // Retrieve the QR Code immediately so the order page can render it without
    // a separate round-trip.
    let pixPayload: string | null = null;
    let pixQrCode: string | null = null;

    try {
      const qr = await this.request<AsaasPixQr>(
        'GET',
        `/payments/${charge.id}/pixQrCode`,
      );
      pixPayload = qr.payload ?? null;
      pixQrCode = qr.encodedImage ?? null;
    } catch (error: unknown) {
      this.logger.warn(
        `Could not retrieve PIX QR Code for charge ${charge.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const expiresAt = new Date(`${charge.dueDate}T23:59:59.000Z`);

    return {
      providerRef: `${ASAAS_PREFIX}${charge.id}`,
      mode: 'hosted',
      url: null,
      clientSecret: null,
      expiresAt,
      method: 'PIX',
      pix: pixPayload
        ? {
            payload: pixPayload,
            encodedImage: pixQrCode,
            expirationDate: expiresAt,
          }
        : null,
    };
  }

  async getPayment(providerRef: string): Promise<SessionLookup> {
    const chargeId = providerRef.replace(ASAAS_PREFIX, '');

    let charge: AsaasCharge;

    try {
      charge = await this.request<AsaasCharge>('GET', `/payments/${chargeId}`);
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return { state: 'gone' };
      }

      throw error;
    }

    // PENDING / AWAITING_RISK_ANALYSIS → still payable.
    if (
      charge.status === 'PENDING' ||
      charge.status === 'AWAITING_RISK_ANALYSIS'
    ) {
      const expiresAt = new Date(`${charge.dueDate}T23:59:59.000Z`);

      return {
        state: 'open',
        session: {
          providerRef,
          mode: 'hosted',
          url: null,
          clientSecret: null,
          expiresAt,
          method: 'PIX',
          pix: null,
        },
      };
    }

    // RECEIVED / CONFIRMED / PARTIALLY_REFUNDED / REFUNDED → committed.
    if (
      charge.status === 'RECEIVED' ||
      charge.status === 'CONFIRMED' ||
      charge.status === 'PARTIALLY_REFUNDED' ||
      charge.status === 'REFUNDED'
    ) {
      return { state: 'completed' };
    }

    // OVERDUE / DELETED / CANCELLED → expired, safe to reissue.
    return { state: 'gone' };
  }

  async expirePayment(providerRef: string): Promise<void> {
    const chargeId = providerRef.replace(ASAAS_PREFIX, '');

    try {
      await this.request('DELETE', `/payments/${chargeId}`);
    } catch (error: unknown) {
      if (!isNotFound(error)) {
        throw error;
      }
      // Already gone — idempotent.
    }
  }

  async refund({
    paymentIntentRef,
  }: {
    paymentIntentRef: string;
  }): Promise<{ refundRef: string }> {
    const chargeId = paymentIntentRef.replace(ASAAS_PREFIX, '');

    const result = await this.request<{ id: string }>(
      'POST',
      `/payments/${chargeId}/refund`,
      {},
    );

    return { refundRef: result.id };
  }

  /**
   * Validates the Asaas webhook token header using a timing-safe comparison.
   *
   * Asaas does not use HMAC — it sends the raw secret in a header. The
   * timing-safe comparison prevents timing oracle attacks even though the
   * secret itself is not hashed.
   */
  parseEvent(rawBody: Buffer, headers: WebhookHeaders): PaymentEvent {
    const token = firstString(headers[ASAAS_TOKEN_HEADER]);

    if (!token) {
      throw new Error('Missing asaas-access-token header');
    }

    // Timing-safe comparison: both buffers must be the same length.
    const expected = Buffer.from(this.webhookSecret, 'utf8');
    const actual = Buffer.from(token, 'utf8');

    // Length mismatch itself reveals nothing — fail the same way.
    const safe =
      expected.length === actual.length && timingSafeEqual(expected, actual);

    if (!safe) {
      throw new Error('Invalid Asaas webhook token');
    }

    const payload = JSON.parse(rawBody.toString('utf8')) as AsaasWebhookPayload;

    return { providerType: payload.event, ...this.classify(payload) };
  }

  private classify(payload: AsaasWebhookPayload): DomainOutcome {
    const chargeId = payload.payment?.id ?? '';
    const eventId = `asaas_${chargeId}_${payload.event}_${Date.now()}`;
    const orderId = payload.payment?.externalReference ?? null;

    switch (payload.event) {
      case 'PAYMENT_RECEIVED':
      case 'PAYMENT_CONFIRMED':
        return {
          id: eventId,
          type: 'payment.succeeded',
          orderId,
          // Asaas uses the charge id as the "intent" — we prefix it for namespacing.
          paymentIntentRef: `${ASAAS_PREFIX}${chargeId}`,
        };

      case 'PAYMENT_REFUNDED':
        return {
          id: eventId,
          type: 'payment.refunded',
          orderId,
          paymentIntentRef: `${ASAAS_PREFIX}${chargeId}`,
          refundRef: null,
        };

      case 'PAYMENT_OVERDUE':
      case 'PAYMENT_DELETED':
        return { id: eventId, type: 'payment.expired', orderId };

      default:
        return { id: eventId, type: 'ignored' };
    }
  }

  /** Creates or retrieves an Asaas customer by email. Returns the Asaas customer id. */
  private async ensureCustomer(buyer: {
    name?: string | null;
    email: string;
    document?: string | null;
  }): Promise<string> {
    // Try to find existing by externalReference = email.
    const list = await this.request<AsaasList<{ id: string }>>(
      'GET',
      `/customers?email=${encodeURIComponent(buyer.email)}&limit=1`,
    );

    if (list.data.length > 0 && list.data[0]) {
      return list.data[0].id;
    }

    const customer = await this.request<{ id: string }>('POST', '/customers', {
      name: buyer.name || buyer.email,
      email: buyer.email,
      ...(buyer.document ? { cpfCnpj: buyer.document } : {}),
      externalReference: buyer.email,
    });

    return customer.id;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        access_token: this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const err = new Error(
        `Asaas ${method} ${path} → ${response.status}: ${text}`,
      ) as NodeJS.ErrnoException & { statusCode?: number };
      err.statusCode = response.status;
      throw err;
    }

    return response.json() as Promise<T>;
  }
}

function firstString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { statusCode?: number }).statusCode === 404 ||
      (error as { statusCode?: number }).statusCode === 400)
  );
}

// ── Asaas API shapes ──────────────────────────────────────────────────────────

interface AsaasCharge {
  id: string;
  status:
    | 'PENDING'
    | 'RECEIVED'
    | 'CONFIRMED'
    | 'AWAITING_RISK_ANALYSIS'
    | 'PARTIALLY_REFUNDED'
    | 'REFUNDED'
    | 'OVERDUE'
    | 'DELETED'
    | 'CANCELLED';
  dueDate: string; // YYYY-MM-DD
  value: number;
  externalReference?: string | null;
}

interface AsaasPixQr {
  encodedImage?: string | null;
  payload?: string | null;
  expirationDate?: string | null;
}

interface AsaasList<T> {
  data: T[];
  totalCount: number;
}

interface AsaasWebhookPayload {
  event: string;
  payment?: {
    id: string;
    externalReference?: string | null;
    status?: string;
  };
}

/** Exported only for use inside the createHmac helper — not part of the public API. */
export { createHmac };
