import { Injectable, Logger } from '@nestjs/common';

import { ASAAS_PREFIX } from './asaas-payment.provider';
import { MERCADOPAGO_PREFIX } from './mercadopago-payment.provider';
import type {
  CreatePaymentInput,
  PaymentEvent,
  PaymentProvider,
  PaymentSession,
  SessionLookup,
  WebhookHeaders,
} from './payment-provider';

/** Header present on Asaas webhooks; absent on Stripe and Mercado Pago. */
const ASAAS_TOKEN_HEADER = 'asaas-access-token';

/** Header present on Mercado Pago webhooks. */
const MP_SIGNATURE_HEADER = 'x-signature';

/** Header present on Stripe webhooks. */
const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

/** Prefix for fake/test payment sessions issued by FakePaymentProvider. */
const FAKE_PREFIX = 'fake_';

/**
 * Routes payment operations to the correct underlying gateway based on the
 * payment method selected at checkout, or by inspecting the `providerRef`
 * prefix for lookups and refunds.
 *
 * Routing table:
 *   PIX            → AsaasPaymentProvider  (asaas_ prefix)
 *   CREDIT_CARD    → MercadoPagoPaymentProvider  (mp_ prefix)
 *   STRIPE / default → StripePaymentProvider / FakePaymentProvider  (cs_ / fake_ prefix)
 *
 * This keeps the orders layer completely unaware of which gateway is active —
 * it always talks to PAYMENT_PROVIDER, and that token resolves to this class.
 */
@Injectable()
export class HybridPaymentProvider implements PaymentProvider {
  private readonly logger = new Logger(HybridPaymentProvider.name);

  constructor(
    private readonly asaas: PaymentProvider,
    private readonly mercadoPago: PaymentProvider,
    private readonly stripe: PaymentProvider,
  ) {}

  createPayment(input: CreatePaymentInput): Promise<PaymentSession> {
    switch (input.method) {
      case 'PIX':
        return this.asaas.createPayment(input);

      case 'CREDIT_CARD':
        return this.mercadoPago.createPayment(input);

      default:
        // STRIPE or undefined → use the configured Stripe/fake provider.
        return this.stripe.createPayment(input);
    }
  }

  getPayment(providerRef: string): Promise<SessionLookup> {
    return this.routeByRef(providerRef).getPayment(providerRef);
  }

  expirePayment(providerRef: string): Promise<void> {
    return this.routeByRef(providerRef).expirePayment(providerRef);
  }

  refund(input: { paymentIntentRef: string }): Promise<{ refundRef: string }> {
    return this.routeByRef(input.paymentIntentRef).refund(input);
  }

  /**
   * Inspects headers to determine which gateway sent this webhook, then
   * delegates verification and translation to the appropriate provider.
   *
   * Asaas and Mercado Pago webhooks are distinguished by their signature
   * headers. When neither is present, the event is assumed to be from Stripe.
   */
  parseEvent(rawBody: Buffer, headers: WebhookHeaders): PaymentEvent {
    if (headerPresent(headers, ASAAS_TOKEN_HEADER)) {
      return this.asaas.parseEvent(rawBody, headers);
    }

    if (headerPresent(headers, MP_SIGNATURE_HEADER)) {
      return this.mercadoPago.parseEvent(rawBody, headers);
    }

    // Default to Stripe / fake — both look for stripe-signature.
    return this.stripe.parseEvent(rawBody, headers);
  }

  /** Selects the provider that owns a given providerRef by its prefix. */
  private routeByRef(providerRef: string): PaymentProvider {
    if (providerRef.startsWith(ASAAS_PREFIX)) {
      return this.asaas;
    }

    if (providerRef.startsWith(MERCADOPAGO_PREFIX)) {
      return this.mercadoPago;
    }

    // cs_… (Stripe) or fake_… (FakePaymentProvider).
    return this.stripe;
  }
}

function headerPresent(headers: WebhookHeaders, name: string): boolean {
  const value = headers[name];
  return value !== undefined && value !== '';
}

/** Re-export for use in the module and specs. */
export {
  ASAAS_PREFIX,
  FAKE_PREFIX,
  MERCADOPAGO_PREFIX,
  STRIPE_SIGNATURE_HEADER,
};
