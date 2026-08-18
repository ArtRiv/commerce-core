import Stripe from 'stripe';

interface StoredSession {
  id: string;
  url: string | null;
  client_secret: string | null;
  status: 'open' | 'complete' | 'expired';
  ui_mode: 'hosted_page' | 'embedded_page';
  expires_at: number;
  client_reference_id: string;
  payment_status: 'paid' | 'unpaid';
  payment_intent: string;
}

interface CreateParams {
  ui_mode: 'hosted_page' | 'embedded_page';
  client_reference_id: string;
  line_items: { price_data: { unit_amount: number } }[];
}

function missingResource(what: string) {
  return Object.assign(new Error(`No such ${what}`), {
    type: 'StripeInvalidRequestError',
    code: 'resource_missing',
  });
}

/**
 * A Stripe client with the network taken out — and only the network.
 *
 * The two calls that would leave the machine (creating a session, issuing a
 * refund) are answered from memory; `webhooks` is the REAL SDK object, so
 * signature verification in the e2e runs the same code production runs. That is
 * possible because verification is an HMAC over a payload with a secret we
 * choose, which needs no account and no network — unlike the mail provider,
 * where the equivalent seam had to be faked wholesale.
 *
 * It also behaves like a gateway rather than a stub: sessions are remembered
 * and can be expired or paid, which is what lets the suite prove that
 * /orders/:id/pay reuses an open session instead of opening a second one.
 */
export class OfflineStripe {
  readonly webhooks: Stripe['webhooks'];

  private readonly sessions = new Map<string, StoredSession>();
  private sequence = 0;

  /** Refund calls that reached the "provider", in order. */
  readonly refundsIssued: string[] = [];

  /** Set to make the next session creation blow up, for the outage case. */
  failNextCreate = false;

  constructor(private readonly sdk: Stripe = new Stripe('sk_test_offline')) {
    this.webhooks = sdk.webhooks;
  }

  readonly checkout = {
    sessions: {
      create: (params: CreateParams): Promise<StoredSession> => {
        if (this.failNextCreate) {
          this.failNextCreate = false;

          return Promise.reject(new Error('Stripe is unreachable'));
        }

        this.sequence += 1;
        const id = `cs_test_${String(this.sequence)}`;
        const embedded = params.ui_mode === 'embedded_page';

        const session: StoredSession = {
          id,
          url: embedded ? null : `https://checkout.stripe.test/${id}`,
          client_secret: embedded ? `${id}_secret` : null,
          status: 'open',
          ui_mode: params.ui_mode,
          expires_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
          client_reference_id: params.client_reference_id,
          payment_status: 'unpaid',
          payment_intent: `pi_test_${String(this.sequence)}`,
        };

        this.sessions.set(id, session);

        return Promise.resolve(session);
      },

      retrieve: (id: string): Promise<StoredSession> => {
        const session = this.sessions.get(id);

        return session
          ? Promise.resolve(session)
          : Promise.reject(missingResource('checkout session'));
      },

      expire: (id: string): Promise<StoredSession> => {
        const session = this.sessions.get(id);

        if (!session) {
          return Promise.reject(missingResource('checkout session'));
        }

        session.status = 'expired';

        return Promise.resolve(session);
      },
    },
  };

  readonly refunds = {
    create: ({
      payment_intent,
    }: {
      payment_intent: string;
    }): Promise<{ id: string }> => {
      this.refundsIssued.push(payment_intent);

      return Promise.resolve({
        id: `re_test_${String(this.refundsIssued.length)}`,
      });
    },
  };

  /** The session as the gateway sees it — for building webhook payloads. */
  session(id: string): StoredSession {
    const session = this.sessions.get(id);

    if (!session) {
      throw new Error(`No such session in the offline gateway: ${id}`);
    }

    return session;
  }

  /** What paying on the provider's page would do, without a browser. */
  markSessionPaid(id: string): StoredSession {
    const session = this.session(id);
    session.payment_status = 'paid';
    session.status = 'complete';

    return session;
  }

  reset(): void {
    this.sessions.clear();
    this.refundsIssued.length = 0;
    this.failNextCreate = false;
    this.sequence = 0;
  }

  /**
   * Signs a payload exactly the way the provider does, so the request under
   * test is indistinguishable from a real delivery. `generateTestHeaderString`
   * is the SDK's own helper for this.
   */
  sign(payload: string, secret: string): string {
    return this.sdk.webhooks.generateTestHeaderString({ payload, secret });
  }
}
