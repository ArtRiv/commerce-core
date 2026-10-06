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

/** Prefix that identifies a Mercado Pago payment reference in the hybrid router. */
export const MERCADOPAGO_PREFIX = 'mp_';

/** Signature header names used by Mercado Pago webhook notifications. */
const MP_SIGNATURE_HEADER = 'x-signature';
const MP_REQUEST_ID_HEADER = 'x-request-id';

/** Maximum number of installments offered to the buyer. */
const MAX_INSTALLMENTS = 12;

/**
 * Mercado Pago Credit Card payment adapter.
 *
 * Creates Checkout Preferences (hosted checkout) for national card payments
 * with transparent installments of up to 12x. Webhook events are authenticated
 * by an HMAC-SHA256 signature sent in the `x-signature` header.
 *
 * This provider is only ever reached when
 * `CreatePaymentInput.method === 'CREDIT_CARD'`. The HybridPaymentProvider
 * handles the routing decision.
 */
@Injectable()
export class MercadoPagoPaymentProvider implements PaymentProvider {
  private readonly logger = new Logger(MercadoPagoPaymentProvider.name);
  private readonly accessToken: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: string;
  private readonly appUrl: string;

  constructor(config: ConfigService) {
    this.accessToken = config.getOrThrow<string>('MERCADOPAGO_ACCESS_TOKEN');
    this.webhookSecret = config.getOrThrow<string>(
      'MERCADOPAGO_WEBHOOK_SECRET',
    );
    this.baseUrl =
      config.get<string>('MERCADOPAGO_BASE_URL') ??
      'https://api.mercadopago.com';
    this.appUrl = config.getOrThrow<string>('APP_URL');
  }

  async createPayment({
    orderId,
    amountCents,
    buyer,
  }: CreatePaymentInput): Promise<PaymentSession> {
    const amount = amountCents / 100;

    // An expiration 30 days out is standard for Mercado Pago preferences.
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const preference = await this.request<MercadoPagoPreference>(
      'POST',
      '/checkout/preferences',
      {
        items: [
          {
            id: orderId,
            title: `Pedido ${orderId}`,
            quantity: 1,
            unit_price: amount,
            currency_id: 'BRL',
          },
        ],
        payer: buyer
          ? {
              name: buyer.name || undefined,
              email: buyer.email,
            }
          : undefined,
        payment_methods: {
          // Exclude cash methods — only cards.
          excluded_payment_types: [
            { id: 'ticket' },
            { id: 'atm' },
            { id: 'bank_transfer' },
            { id: 'prepaid_card' },
          ],
          installments: MAX_INSTALLMENTS,
        },
        back_urls: {
          success: `${this.appUrl}/checkout/success?order=${encodeURIComponent(orderId)}`,
          failure: `${this.appUrl}/checkout/cancel?order=${encodeURIComponent(orderId)}`,
          pending: `${this.appUrl}/pedido/${encodeURIComponent(orderId)}`,
        },
        auto_return: 'approved',
        external_reference: orderId,
        expiration_date_to: expiresAt.toISOString(),
        notification_url: `${this.appUrl.replace(/\/$/, '')}/api/v1/payments/webhook/mercadopago`,
      },
    );

    // Use sandbox_init_point in test/sandbox mode.
    const isSandbox = this.accessToken.startsWith('TEST-');
    const url = isSandbox
      ? (preference.sandbox_init_point ?? preference.init_point)
      : preference.init_point;

    return {
      providerRef: `${MERCADOPAGO_PREFIX}${preference.id}`,
      mode: 'hosted',
      url,
      clientSecret: null,
      expiresAt,
      method: 'CREDIT_CARD',
      pix: null,
    };
  }

  async getPayment(providerRef: string): Promise<SessionLookup> {
    const preferenceId = providerRef.replace(MERCADOPAGO_PREFIX, '');

    let preference: MercadoPagoPreference;

    try {
      preference = await this.request<MercadoPagoPreference>(
        'GET',
        `/checkout/preferences/${preferenceId}`,
      );
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return { state: 'gone' };
      }

      throw error;
    }

    const expiresAt = preference.expiration_date_to
      ? new Date(preference.expiration_date_to)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    if (preference.active === false || expiresAt < new Date()) {
      return { state: 'gone' };
    }

    const isSandbox = this.accessToken.startsWith('TEST-');
    const url = isSandbox
      ? (preference.sandbox_init_point ?? preference.init_point)
      : preference.init_point;

    return {
      state: 'open',
      session: {
        providerRef,
        mode: 'hosted',
        url,
        clientSecret: null,
        expiresAt,
        method: 'CREDIT_CARD',
        pix: null,
      },
    };
  }

  async expirePayment(providerRef: string): Promise<void> {
    const preferenceId = providerRef.replace(MERCADOPAGO_PREFIX, '');

    // Deactivate the preference by setting expiration to now.
    try {
      await this.request('PUT', `/checkout/preferences/${preferenceId}`, {
        active: false,
      });
    } catch (error: unknown) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }

  async refund({
    paymentIntentRef,
  }: {
    paymentIntentRef: string;
  }): Promise<{ refundRef: string }> {
    const paymentId = paymentIntentRef.replace(MERCADOPAGO_PREFIX, '');

    const result = await this.request<{ id: number }>(
      'POST',
      `/v1/payments/${paymentId}/refunds`,
      {},
    );

    return { refundRef: String(result.id) };
  }

  /**
   * Validates the Mercado Pago webhook signature.
   *
   * MP sends an `x-signature` header in the format `ts=<timestamp>,v1=<hmac>`.
   * The signed string is `id:<x-request-id>;request-id:<x-request-id>;ts:<ts>;`.
   * The HMAC-SHA256 is computed with MERCADOPAGO_WEBHOOK_SECRET.
   *
   * Reference: https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
   */
  parseEvent(rawBody: Buffer, headers: WebhookHeaders): PaymentEvent {
    const signatureHeader = firstString(headers[MP_SIGNATURE_HEADER]);
    const requestId = firstString(headers[MP_REQUEST_ID_HEADER]) ?? '';

    if (!signatureHeader) {
      throw new Error(`Missing ${MP_SIGNATURE_HEADER} header`);
    }

    const parts = Object.fromEntries(
      signatureHeader.split(',').map((part) => part.split('=')),
    ) as Record<string, string>;

    const ts = parts['ts'];
    const v1 = parts['v1'];

    if (!ts || !v1) {
      throw new Error('Malformed x-signature header');
    }

    // Compute our expected signature.
    const signedData = `id:${requestId};request-id:${requestId};ts:${ts};`;
    const expected = createHmac('sha256', this.webhookSecret)
      .update(signedData)
      .digest('hex');

    // timingSafeEqual requires buffers of the same length. We only compare
    // when lengths match; a length mismatch is already a forgery indicator
    // and fails the same path.
    const expectedBuf = Buffer.from(expected);
    const actualBuf = Buffer.from(v1);

    const valid =
      expectedBuf.length === actualBuf.length &&
      timingSafeEqual(expectedBuf, actualBuf);

    if (!valid) {
      throw new Error('Invalid Mercado Pago webhook signature');
    }

    const payload = JSON.parse(
      rawBody.toString('utf8'),
    ) as MercadoPagoWebhookPayload;

    return {
      providerType: payload.type ?? payload.action ?? 'unknown',
      ...this.classify(payload),
    };
  }

  private classify(payload: MercadoPagoWebhookPayload): DomainOutcome {
    // MP webhook "type" can be "payment" and "action" can be "payment.updated".
    const isPaymentEvent =
      payload.type === 'payment' ||
      (payload.action ?? '').startsWith('payment');

    if (!isPaymentEvent) {
      return { id: String(payload.id ?? 'mp_unknown'), type: 'ignored' };
    }

    const dataId = String(payload.data?.id ?? payload.id ?? 'unknown');
    const eventId = `${MERCADOPAGO_PREFIX}${dataId}_${Date.now()}`;
    const paymentIntentRef = `${MERCADOPAGO_PREFIX}${dataId}`;

    // We need the order id from the payment data. MP does not send it in the
    // webhook body in a reliable position — the external_reference is on the
    // payment object, which requires a follow-up GET. We persist it via
    // PaymentEventsService.resolveOrderId using the paymentIntentRef index.
    return {
      id: eventId,
      type: 'payment.succeeded',
      orderId: payload.data?.external_reference ?? null,
      paymentIntentRef,
    };
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `${method}-${path}-${Date.now()}`,
        Accept: 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const err = new Error(
        `MercadoPago ${method} ${path} → ${response.status}: ${text}`,
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

// ── Mercado Pago API shapes ────────────────────────────────────────────────────

interface MercadoPagoPreference {
  id: string;
  init_point: string;
  sandbox_init_point?: string | null;
  active?: boolean;
  expiration_date_to?: string | null;
  external_reference?: string | null;
}

interface MercadoPagoWebhookPayload {
  id?: string | number;
  type?: string;
  action?: string;
  data?: {
    id?: string | number;
    external_reference?: string | null;
    status?: string;
  };
}
