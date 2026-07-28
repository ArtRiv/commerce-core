import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Stripe from 'stripe';

import type {
  CheckoutMode,
  CreatePaymentInput,
  DomainOutcome,
  PaymentEvent,
  PaymentProvider,
  PaymentSession,
  SessionLookup,
  WebhookHeaders,
} from './payment-provider';
import { STRIPE_CLIENT } from './stripe-client';

const DEFAULT_CURRENCY = 'brl';

/** Stripe's own header. Nothing outside this file needs to know the name. */
const SIGNATURE_HEADER = 'stripe-signature';

/** Our vocabulary → Stripe's, which has changed names before and will again. */
const UI_MODE: Record<CheckoutMode, 'hosted_page' | 'embedded_page'> = {
  hosted: 'hosted_page',
  embedded: 'embedded_page',
};

/** Stripe hands back either an id or the expanded object, depending on the call. */
function refOf(
  value: string | { id: string } | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  return typeof value === 'string' ? value : value.id;
}

/**
 * Both of these take deliberately looser types than the SDK declares.
 *
 * Stripe types metadata as a total `{ [k: string]: string }` and a list's
 * `data` as a plain array, so TypeScript believes `metadata.orderId` and
 * `data[0]` always exist — while over the wire they routinely do not. Widening
 * at the boundary is what lets the optional chaining below stay, instead of
 * being "simplified" away by a linter that trusts the declaration.
 */
function metadataOrderId(
  metadata: Record<string, string | undefined> | null,
): string | null {
  return metadata?.orderId ?? null;
}

function firstRefundId(
  refunds?: { data: ({ id: string } | undefined)[] } | null,
): string | null {
  return refunds?.data[0]?.id ?? null;
}

/** A reference that no longer exists is a new session's problem, not an error. */
function isMissingResource(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'resource_missing'
  );
}

/**
 * The real gateway behind PaymentProvider.
 *
 * Everything Stripe-shaped stops here: the SDK types, the `hosted_page` /
 * `embedded_page` spelling, the event taxonomy. What leaves is the domain's own
 * PaymentSession and PaymentEvent, which is what lets `orders` react to a
 * webhook without importing Stripe. See docs/specs/payments.md.
 */
@Injectable()
export class StripePaymentProvider implements PaymentProvider {
  private readonly webhookSecret: string;
  private readonly appUrl: string;
  private readonly currency: string;
  private readonly defaultMode: CheckoutMode;

  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    config: ConfigService,
  ) {
    // getOrThrow: this class only ever gets constructed when the config check
    // already found both variables, so a miss here is a wiring bug worth
    // failing the boot over.
    this.webhookSecret = config.getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
    // The frontend base, not this API: these are pages a browser lands on
    // after paying, exactly like the emailed verification links.
    this.appUrl = config.getOrThrow<string>('APP_URL');
    this.currency = (
      config.get<string>('STRIPE_CURRENCY') ?? DEFAULT_CURRENCY
    ).toLowerCase();
    this.defaultMode =
      config.get<string>('STRIPE_CHECKOUT_MODE') === 'embedded'
        ? 'embedded'
        : 'hosted';
  }

  async createPayment({
    orderId,
    amountCents,
    mode,
  }: CreatePaymentInput): Promise<PaymentSession> {
    const checkoutMode = mode ?? this.defaultMode;

    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      ui_mode: UI_MODE[checkoutMode],
      // Two carriers for one fact, because different events expose different
      // ones: session events read client_reference_id, while the intent and
      // its charges inherit the metadata below.
      client_reference_id: orderId,
      metadata: { orderId },
      payment_intent_data: { metadata: { orderId } },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: this.currency,
            unit_amount: amountCents,
            // One aggregate line, not the order's items: the itemisation is
            // already frozen in order_items, and duplicating it here would put
            // a second copy of the financial record inside Stripe.
            product_data: { name: `Pedido ${orderId}` },
          },
        },
      ],
      ...(checkoutMode === 'embedded'
        ? // Stripe requires return_url here and rejects the other two.
          { return_url: this.appLink('return', orderId) }
        : {
            success_url: this.appLink('success', orderId),
            cancel_url: this.appLink('cancel', orderId),
          }),
    });

    return this.toSession(session, checkoutMode);
  }

  async getPayment(providerRef: string): Promise<SessionLookup> {
    let session: Stripe.Checkout.Session;

    try {
      session = await this.stripe.checkout.sessions.retrieve(providerRef);
    } catch (error: unknown) {
      // Only "there is no such session" is a real answer. A network failure
      // must propagate: reporting "nothing here" during an outage would have
      // the caller cheerfully create a second way to pay the same order.
      if (isMissingResource(error)) {
        return { state: 'gone' };
      }

      throw error;
    }

    if (session.status === 'open') {
      return {
        state: 'open',
        session: this.toSession(
          session,
          session.ui_mode === 'embedded_page' ? 'embedded' : 'hosted',
        ),
      };
    }

    // 'complete' means the buyer went through checkout — paid outright, or an
    // asynchronous method still settling. Both must block a replacement
    // session; only a genuinely dead one ('expired') may be replaced.
    return session.status === 'complete'
      ? { state: 'completed' }
      : { state: 'gone' };
  }

  async expirePayment(providerRef: string): Promise<void> {
    await this.stripe.checkout.sessions.expire(providerRef);
  }

  async refund({
    paymentIntentRef,
  }: {
    paymentIntentRef: string;
  }): Promise<{ refundRef: string }> {
    // Against the intent rather than the charge: one intent may have exactly
    // one successful charge, and Stripe resolves it for us.
    const refund = await this.stripe.refunds.create({
      payment_intent: paymentIntentRef,
    });

    return { refundRef: refund.id };
  }

  parseEvent(rawBody: Buffer, headers: WebhookHeaders): PaymentEvent {
    const signature = headers[SIGNATURE_HEADER];

    // Throws on a bad or absent signature, and nothing below runs — the body
    // is not parsed, let alone trusted, until this passes. An empty string for
    // a missing header lands in the same failure, which is the right outcome:
    // "no signature" and "wrong signature" are equally unauthenticated.
    const event = this.stripe.webhooks.constructEvent(
      rawBody,
      signature ?? '',
      this.webhookSecret,
    );

    // The provider's own event name rides along untranslated, for the audit
    // row; the domain classification is what everything else acts on.
    return { providerType: event.type, ...this.classify(event) };
  }

  private classify(event: Stripe.Event): DomainOutcome {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;
        const paymentIntentRef = refOf(session.payment_intent);

        // A completed session is not necessarily a paid one: boleto and Pix
        // complete first and pay later, then arrive again as async_payment_*.
        if (session.payment_status !== 'paid' || !paymentIntentRef) {
          return { id: event.id, type: 'ignored' };
        }

        return {
          id: event.id,
          type: 'payment.succeeded',
          orderId: session.client_reference_id,
          paymentIntentRef,
        };
      }

      case 'checkout.session.async_payment_failed':
        return {
          id: event.id,
          type: 'payment.failed',
          orderId: event.data.object.client_reference_id,
        };

      case 'checkout.session.expired':
        return {
          id: event.id,
          type: 'payment.expired',
          orderId: event.data.object.client_reference_id,
        };

      case 'charge.refunded': {
        const charge = event.data.object;
        const paymentIntentRef = refOf(charge.payment_intent);

        if (!paymentIntentRef) {
          return { id: event.id, type: 'ignored' };
        }

        // Stripe fires this for PARTIAL refunds too, where `refunded` stays
        // false. Treating one as a full reversal would flip the order to
        // REFUNDED and put every line item back on the shelf while most of the
        // money is still held — inventory invented, order unshippable. Issuing
        // partial refunds is out of scope (docs/specs/payments.md), but the
        // event arrives whether we support the feature or not.
        if (!charge.refunded) {
          return { id: event.id, type: 'ignored' };
        }

        return {
          id: event.id,
          type: 'payment.refunded',
          orderId: metadataOrderId(charge.metadata),
          paymentIntentRef,
          // Not always expanded on the charge. Null is fine: the refund id is
          // a convenience, the status change is the point.
          refundRef: firstRefundId(charge.refunds),
        };
      }

      default:
        // Every other event an account emits is none of this module's
        // business — recorded and acknowledged, never an error.
        return { id: event.id, type: 'ignored' };
    }
  }

  private toSession(
    session: Stripe.Checkout.Session,
    mode: CheckoutMode,
  ): PaymentSession {
    return {
      providerRef: session.id,
      mode,
      url: session.url ?? null,
      clientSecret: session.client_secret ?? null,
      // Stripe counts in seconds, JavaScript in milliseconds.
      expiresAt: new Date(session.expires_at * 1000),
    };
  }

  private appLink(page: string, orderId: string): string {
    return `${this.appUrl}/checkout/${page}?order=${encodeURIComponent(orderId)}`;
  }
}
