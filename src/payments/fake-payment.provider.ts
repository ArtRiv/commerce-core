import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  CheckoutMode,
  CreatePaymentInput,
  PaymentEvent,
  PaymentProvider,
  PaymentSession,
} from './payment-provider';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const EVENT_TYPES = new Set([
  'payment.succeeded',
  'payment.failed',
  'payment.expired',
  'payment.refunded',
  'ignored',
]);

/**
 * The provider for anywhere Stripe is not configured: local development, CI,
 * and the parts of the e2e suite that are not about Stripe.
 *
 * It is a real implementation of the interface rather than a stub — it issues
 * sessions, remembers them so /orders/:id/pay can exercise its reuse path, and
 * expires them — so the whole purchase flow works end to end on a fresh clone
 * with no Stripe account. What it cannot do is verify a signature: parseEvent
 * accepts an unsigned domain event straight from the body, which is a gaping
 * hole and precisely why PaymentsModule refuses to bind this provider when
 * NODE_ENV is production.
 *
 * Sessions live in memory, so they do not survive a restart. That is the
 * correct amount of fidelity for a fake: the order simply looks like one whose
 * session expired, and /pay issues another.
 */
@Injectable()
export class FakePaymentProvider implements PaymentProvider {
  private readonly sessions = new Map<string, PaymentSession>();
  private readonly appUrl: string;
  private readonly defaultMode: CheckoutMode;

  constructor(config: ConfigService) {
    this.appUrl = config.get<string>('APP_URL') ?? 'http://localhost:5173';
    this.defaultMode =
      config.get<string>('STRIPE_CHECKOUT_MODE') === 'embedded'
        ? 'embedded'
        : 'hosted';
  }

  createPayment({
    orderId,
    mode,
  }: CreatePaymentInput): Promise<PaymentSession> {
    const checkoutMode = mode ?? this.defaultMode;
    const providerRef = `fake_cs_${randomUUID()}`;

    const session: PaymentSession = {
      providerRef,
      mode: checkoutMode,
      url:
        checkoutMode === 'hosted'
          ? `${this.appUrl}/checkout/fake?order=${encodeURIComponent(orderId)}&session=${providerRef}`
          : null,
      clientSecret:
        checkoutMode === 'embedded' ? `${providerRef}_secret` : null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    };

    this.sessions.set(providerRef, session);

    return Promise.resolve(session);
  }

  getPayment(providerRef: string): Promise<PaymentSession | null> {
    const session = this.sessions.get(providerRef);

    if (!session || session.expiresAt.getTime() <= Date.now()) {
      return Promise.resolve(null);
    }

    return Promise.resolve(session);
  }

  expirePayment(providerRef: string): Promise<void> {
    this.sessions.delete(providerRef);

    return Promise.resolve();
  }

  refund(): Promise<{ refundRef: string }> {
    return Promise.resolve({ refundRef: `fake_re_${randomUUID()}` });
  }

  /**
   * No signature to check — the body IS the domain event, so a developer can
   * drive the webhook with curl. The shape is still validated, so the route's
   * 400 path stays reachable without Stripe.
   */
  parseEvent(rawBody: Buffer): PaymentEvent {
    const parsed: unknown = JSON.parse(rawBody.toString('utf8'));

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { id?: unknown }).id !== 'string' ||
      !EVENT_TYPES.has(String((parsed as { type?: unknown }).type))
    ) {
      throw new Error('Body is not a payment event');
    }

    return parsed as PaymentEvent;
  }
}
