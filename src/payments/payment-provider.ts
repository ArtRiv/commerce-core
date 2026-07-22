/**
 * Charging money, behind a token — the same seam as MailService: orders
 * depends on this interface, never on a concrete gateway, so swapping the
 * FakePaymentProvider for Stripe is a payments-module change and nothing
 * else (docs/architecture/modules.md, docs/specs/payments.md).
 *
 * Everything crossing this boundary speaks OUR vocabulary, not the gateway's.
 * That is not decoration: Stripe's own `ui_mode` values are `hosted_page` and
 * `embedded_page` today and were `hosted`/`embedded` before, and its event
 * names are its own taxonomy. Translating once, here, is what lets the webhook
 * controller live in `orders` without orders ever importing Stripe — which is
 * what keeps the module arrow pointing orders → payments instead of both ways.
 */

/**
 * How the buyer pays.
 *
 * `hosted` — the provider hosts the page; we hand back a URL to open.
 * `embedded` — the storefront renders its own checkout page and mounts the
 * provider's payment form inside it, using the returned client secret. The
 * storefront owns layout and branding either way; what it never owns is the
 * card fields themselves, which is what keeps PCI scope at SAQ-A.
 */
export const CHECKOUT_MODES = ['hosted', 'embedded'] as const;

export type CheckoutMode = (typeof CHECKOUT_MODES)[number];

export interface PaymentSession {
  /** The session reference to store on the order (cs_… on Stripe). */
  providerRef: string;
  mode: CheckoutMode;
  /** Where to send the buyer. Always null in embedded mode. */
  url: string | null;
  /**
   * For embedded mode. Deliberately never persisted — it is short-lived, and a
   * client that lost it asks for a new one via POST /orders/:id/pay.
   */
  clientSecret: string | null;
  expiresAt: Date;
}

/**
 * What a verified webhook turned out to mean, in domain terms.
 *
 * `ignored` is a first-class outcome, not a failure: most of what an account
 * emits is none of this module's business, and it still deserves a recorded,
 * acknowledged 200 rather than an error.
 */
export type PaymentEvent =
  | {
      id: string;
      type: 'payment.succeeded';
      orderId: string | null;
      paymentIntentRef: string;
    }
  | { id: string; type: 'payment.failed'; orderId: string | null }
  | { id: string; type: 'payment.expired'; orderId: string | null }
  | {
      id: string;
      type: 'payment.refunded';
      orderId: string | null;
      paymentIntentRef: string;
      /** Null when the provider did not hand us one; the status is the point. */
      refundRef: string | null;
    }
  | { id: string; type: 'ignored' };

/** Node's incoming header bag, narrowed to what a verifier needs. */
export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface CreatePaymentInput {
  orderId: string;
  amountCents: number;
  /** Falls back to the provider's configured default. */
  mode?: CheckoutMode;
}

export interface PaymentProvider {
  createPayment(input: CreatePaymentInput): Promise<PaymentSession>;

  /**
   * The session behind a stored reference, or null if it can no longer be paid
   * (expired, completed, or never existed). Null is the signal to issue a new
   * one; reusing an open session is what stops a single order growing two ways
   * to pay it, which is the same thing as two ways to charge the buyer.
   */
  getPayment(providerRef: string): Promise<PaymentSession | null>;

  /** Closes a session for an order that is no longer payable (cancelled). */
  expirePayment(providerRef: string): Promise<void>;

  refund(input: { paymentIntentRef: string }): Promise<{ refundRef: string }>;

  /**
   * Verifies the signature and translates the payload. MUST throw when the
   * signature does not check out, and must read nothing from the body before
   * it does: that signature is the only thing separating a real event from
   * anyone on the internet claiming an order was paid.
   *
   * Takes the whole header bag rather than a signature string because WHICH
   * header carries the signature is the provider's business — `stripe-signature`
   * here, something else for the next gateway. The caller passes what it
   * received and stays ignorant.
   */
  parseEvent(rawBody: Buffer, headers: WebhookHeaders): PaymentEvent;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
