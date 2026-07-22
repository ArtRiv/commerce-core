import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConfigService } from '@nestjs/config';
import type Stripe from 'stripe';

import { StripePaymentProvider } from './stripe-payment.provider';

const WEBHOOK_SECRET = 'whsec_test';
const APP_URL = 'https://loja.example.com';

function createStripeMock() {
  return {
    checkout: {
      sessions: {
        create: jest.fn<Promise<unknown>, [unknown]>(),
        retrieve: jest.fn<Promise<unknown>, [string]>(),
        expire: jest.fn<Promise<unknown>, [string]>(),
      },
    },
    refunds: {
      create: jest.fn<Promise<unknown>, [unknown]>(),
    },
    webhooks: {
      constructEvent: jest.fn<unknown, [Buffer, string, string]>(),
    },
  };
}

type StripeMock = ReturnType<typeof createStripeMock>;

function configWith(values: Record<string, string> = {}) {
  const settings: Record<string, string | undefined> = {
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    APP_URL,
    ...values,
  };

  return {
    get: (key: string) => settings[key],
    getOrThrow: (key: string) => {
      const value = settings[key];
      if (value === undefined) {
        throw new Error(`Missing ${key}`);
      }

      return value;
    },
  } as unknown as ConfigService;
}

function providerWith(stripe: StripeMock, values?: Record<string, string>) {
  return new StripePaymentProvider(
    stripe as unknown as Stripe,
    configWith(values),
  );
}

/** The header bag as the controller hands it over, signature included. */
function signed(signature: string) {
  return { 'stripe-signature': signature, 'content-type': 'application/json' };
}

/** A Checkout Session as Stripe returns it, trimmed to what the adapter reads. */
function stripeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_123',
    url: 'https://checkout.stripe.com/c/pay/cs_test_123',
    client_secret: null,
    status: 'open',
    ui_mode: 'hosted_page',
    // 2026-07-22T00:00:00Z, in the seconds-since-epoch Stripe speaks.
    expires_at: 1784592000,
    ...overrides,
  };
}

function createArgs(stripe: StripeMock) {
  return stripe.checkout.sessions.create.mock.calls[0][0] as {
    mode: string;
    ui_mode: string;
    client_reference_id: string;
    metadata: { orderId: string };
    payment_intent_data: { metadata: { orderId: string } };
    line_items: {
      quantity: number;
      price_data: {
        currency: string;
        unit_amount: number;
        product_data: { name: string };
      };
    }[];
    success_url?: string;
    cancel_url?: string;
    return_url?: string;
  };
}

describe('StripePaymentProvider', () => {
  describe('createPayment', () => {
    it('creates a hosted session carrying the order id in both places', async () => {
      const stripe = createStripeMock();
      stripe.checkout.sessions.create.mockResolvedValue(stripeSession());

      const session = await providerWith(stripe).createPayment({
        orderId: 'order-1',
        amountCents: 4500,
        mode: 'hosted',
      });

      const args = createArgs(stripe);
      expect(args.mode).toBe('payment');
      // Our 'hosted' is Stripe's 'hosted_page' — the whole reason the domain
      // has its own vocabulary.
      expect(args.ui_mode).toBe('hosted_page');
      expect(args.client_reference_id).toBe('order-1');
      expect(args.metadata.orderId).toBe('order-1');
      // On the intent too: charge-level events carry no client_reference_id,
      // and inherited metadata is how they find their order.
      expect(args.payment_intent_data.metadata.orderId).toBe('order-1');
      expect(args.line_items[0].price_data.unit_amount).toBe(4500);
      expect(args.line_items[0].price_data.currency).toBe('brl');
      expect(args.success_url).toContain(APP_URL);
      expect(args.cancel_url).toContain(APP_URL);
      expect(args.return_url).toBeUndefined();

      expect(session).toEqual({
        providerRef: 'cs_test_123',
        mode: 'hosted',
        url: 'https://checkout.stripe.com/c/pay/cs_test_123',
        clientSecret: null,
        expiresAt: new Date(1784592000 * 1000),
      });
    });

    it('creates an embedded session with a return_url and no redirect urls', async () => {
      const stripe = createStripeMock();
      stripe.checkout.sessions.create.mockResolvedValue(
        stripeSession({
          url: null,
          client_secret: 'cs_test_123_secret_abc',
          ui_mode: 'embedded_page',
        }),
      );

      const session = await providerWith(stripe).createPayment({
        orderId: 'order-1',
        amountCents: 4500,
        mode: 'embedded',
      });

      const args = createArgs(stripe);
      expect(args.ui_mode).toBe('embedded_page');
      // Stripe rejects success_url/cancel_url in this mode and requires
      // return_url — getting this backwards is a 400 from Stripe, not a
      // graceful degradation.
      expect(args.return_url).toContain(APP_URL);
      expect(args.success_url).toBeUndefined();
      expect(args.cancel_url).toBeUndefined();

      expect(session.url).toBeNull();
      expect(session.clientSecret).toBe('cs_test_123_secret_abc');
      expect(session.mode).toBe('embedded');
    });

    it('falls back to the configured default mode and currency', async () => {
      const stripe = createStripeMock();
      stripe.checkout.sessions.create.mockResolvedValue(
        stripeSession({
          url: null,
          client_secret: 'sec',
          ui_mode: 'embedded_page',
        }),
      );

      await providerWith(stripe, {
        STRIPE_CHECKOUT_MODE: 'embedded',
        STRIPE_CURRENCY: 'USD',
      }).createPayment({ orderId: 'order-1', amountCents: 100 });

      const args = createArgs(stripe);
      expect(args.ui_mode).toBe('embedded_page');
      // Stripe wants the currency lowercased.
      expect(args.line_items[0].price_data.currency).toBe('usd');
    });
  });

  describe('getPayment', () => {
    it('returns the session while it is still open', async () => {
      const stripe = createStripeMock();
      stripe.checkout.sessions.retrieve.mockResolvedValue(stripeSession());

      const session = await providerWith(stripe).getPayment('cs_test_123');

      expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledWith(
        'cs_test_123',
      );
      expect(session?.providerRef).toBe('cs_test_123');
      expect(session?.mode).toBe('hosted');
    });

    it.each(['complete', 'expired'])(
      'returns null for a %s session, so a new one gets issued',
      async (status) => {
        const stripe = createStripeMock();
        stripe.checkout.sessions.retrieve.mockResolvedValue(
          stripeSession({ status }),
        );

        await expect(
          providerWith(stripe).getPayment('cs_test_123'),
        ).resolves.toBeNull();
      },
    );

    it('returns null when the reference no longer exists at the provider', async () => {
      const stripe = createStripeMock();
      stripe.checkout.sessions.retrieve.mockRejectedValue(
        Object.assign(new Error('No such checkout session'), {
          type: 'StripeInvalidRequestError',
          code: 'resource_missing',
        }),
      );

      await expect(
        providerWith(stripe).getPayment('cs_test_gone'),
      ).resolves.toBeNull();
    });

    it('propagates a transport failure instead of reporting no session', async () => {
      const stripe = createStripeMock();
      stripe.checkout.sessions.retrieve.mockRejectedValue(
        Object.assign(new Error('connection error'), {
          type: 'StripeConnectionError',
        }),
      );

      // Swallowing this would answer "no open session" during an outage, and
      // the caller would helpfully create a second way to pay the same order.
      await expect(
        providerWith(stripe).getPayment('cs_test_123'),
      ).rejects.toThrow('connection error');
    });
  });

  describe('expirePayment and refund', () => {
    it('expires a session by reference', async () => {
      const stripe = createStripeMock();
      stripe.checkout.sessions.expire.mockResolvedValue(stripeSession());

      await providerWith(stripe).expirePayment('cs_test_123');

      expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith(
        'cs_test_123',
      );
    });

    it('refunds against the intent, not the session', async () => {
      const stripe = createStripeMock();
      stripe.refunds.create.mockResolvedValue({ id: 're_1' });

      const result = await providerWith(stripe).refund({
        paymentIntentRef: 'pi_1',
      });

      expect(stripe.refunds.create).toHaveBeenCalledWith({
        payment_intent: 'pi_1',
      });
      expect(result).toEqual({ refundRef: 're_1' });
    });
  });

  describe('parseEvent', () => {
    const body = Buffer.from('{"id":"evt_1"}');

    function primeEvent(stripe: StripeMock, event: unknown) {
      stripe.webhooks.constructEvent.mockReturnValue(event);
    }

    it('verifies the signature against the configured secret before reading anything', () => {
      const stripe = createStripeMock();
      primeEvent(stripe, { id: 'evt_1', type: 'invoice.paid', data: {} });

      providerWith(stripe).parseEvent(body, signed('sig_header'));

      expect(stripe.webhooks.constructEvent).toHaveBeenCalledWith(
        body,
        signed('sig_header')['stripe-signature'],
        WEBHOOK_SECRET,
      );
    });

    it('propagates a signature failure', () => {
      const stripe = createStripeMock();
      stripe.webhooks.constructEvent.mockImplementation(() => {
        throw new Error('No signatures found matching the expected signature');
      });

      expect(() =>
        providerWith(stripe).parseEvent(body, signed('bad')),
      ).toThrow('No signatures found');
    });

    it('maps a paid checkout session to payment.succeeded', () => {
      const stripe = createStripeMock();
      primeEvent(stripe, {
        id: 'evt_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_1',
            payment_status: 'paid',
            client_reference_id: 'order-1',
            payment_intent: 'pi_1',
          },
        },
      });

      expect(providerWith(stripe).parseEvent(body, signed('sig'))).toEqual({
        id: 'evt_1',
        // The gateway's own name rides along for the audit row, untranslated.
        providerType: 'checkout.session.completed',
        type: 'payment.succeeded',
        orderId: 'order-1',
        paymentIntentRef: 'pi_1',
      });
    });

    it('ignores a completed session that has not actually been paid', () => {
      const stripe = createStripeMock();
      // Async methods (boleto, Pix) complete the session first and pay later;
      // acting here would mark an unpaid order PAID.
      primeEvent(stripe, {
        id: 'evt_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_1',
            payment_status: 'unpaid',
            client_reference_id: 'order-1',
            payment_intent: 'pi_1',
          },
        },
      });

      expect(providerWith(stripe).parseEvent(body, signed('sig'))).toEqual({
        id: 'evt_1',
        providerType: 'checkout.session.completed',
        type: 'ignored',
      });
    });

    it('maps the async success that follows it to payment.succeeded', () => {
      const stripe = createStripeMock();
      primeEvent(stripe, {
        id: 'evt_2',
        type: 'checkout.session.async_payment_succeeded',
        data: {
          object: {
            id: 'cs_1',
            payment_status: 'paid',
            client_reference_id: 'order-1',
            payment_intent: { id: 'pi_1' },
          },
        },
      });

      expect(providerWith(stripe).parseEvent(body, signed('sig'))).toEqual({
        id: 'evt_2',
        providerType: 'checkout.session.async_payment_succeeded',
        type: 'payment.succeeded',
        orderId: 'order-1',
        paymentIntentRef: 'pi_1',
      });
    });

    it.each([
      ['checkout.session.async_payment_failed', 'payment.failed'],
      ['checkout.session.expired', 'payment.expired'],
    ])('maps %s to %s', (stripeType, domainType) => {
      const stripe = createStripeMock();
      primeEvent(stripe, {
        id: 'evt_3',
        type: stripeType,
        data: {
          object: {
            id: 'cs_1',
            payment_status: 'unpaid',
            client_reference_id: 'order-1',
          },
        },
      });

      expect(providerWith(stripe).parseEvent(body, signed('sig'))).toEqual({
        id: 'evt_3',
        providerType: stripeType,
        type: domainType,
        orderId: 'order-1',
      });
    });

    it('maps charge.refunded to payment.refunded, resolvable by intent', () => {
      const stripe = createStripeMock();
      primeEvent(stripe, {
        id: 'evt_4',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_1',
            payment_intent: 'pi_1',
            metadata: { orderId: 'order-1' },
            refunds: { data: [{ id: 're_1' }] },
          },
        },
      });

      expect(providerWith(stripe).parseEvent(body, signed('sig'))).toEqual({
        id: 'evt_4',
        providerType: 'charge.refunded',
        type: 'payment.refunded',
        orderId: 'order-1',
        paymentIntentRef: 'pi_1',
        refundRef: 're_1',
      });
    });

    it('still reports a refund whose refund id was not expanded', () => {
      const stripe = createStripeMock();
      primeEvent(stripe, {
        id: 'evt_5',
        type: 'charge.refunded',
        data: {
          object: { id: 'ch_1', payment_intent: 'pi_1', metadata: {} },
        },
      });

      expect(providerWith(stripe).parseEvent(body, signed('sig'))).toEqual({
        id: 'evt_5',
        providerType: 'charge.refunded',
        type: 'payment.refunded',
        orderId: null,
        paymentIntentRef: 'pi_1',
        refundRef: null,
      });
    });

    it('ignores everything else the account happens to emit', () => {
      const stripe = createStripeMock();
      primeEvent(stripe, {
        id: 'evt_6',
        type: 'customer.created',
        data: { object: { id: 'cus_1' } },
      });

      expect(providerWith(stripe).parseEvent(body, signed('sig'))).toEqual({
        id: 'evt_6',
        // The whole point of carrying providerType: an ignored event is no
        // longer an anonymous "ignored" in the audit trail.
        providerType: 'customer.created',
        type: 'ignored',
      });
    });

    it('parses a REAL charge.refunded captured from Stripe (2026-06-24.dahlia)', () => {
      // test/fixtures/charge-refunded.json was captured with `stripe trigger
      // charge.refunded` and frozen. It is the reality check on the hand-built
      // fixtures above: in this API version the event carries neither an
      // expanded `refunds` list nor charge-level metadata, only payment_intent.
      // So refundRef is null and orderId is null here — the order is instead
      // resolved downstream by paymentIntentRef (see PaymentEventsService), and
      // a null refund ref is fine because the status change is the point.
      const realEvent: unknown = JSON.parse(
        readFileSync(
          join(__dirname, '../../test/fixtures/charge-refunded.json'),
          'utf8',
        ),
      );
      const intent = (
        realEvent as { data: { object: { payment_intent: string } } }
      ).data.object.payment_intent;

      const stripe = createStripeMock();
      stripe.webhooks.constructEvent.mockReturnValue(realEvent);

      expect(providerWith(stripe).parseEvent(body, signed('sig'))).toEqual({
        id: (realEvent as { id: string }).id,
        providerType: 'charge.refunded',
        type: 'payment.refunded',
        orderId: null,
        paymentIntentRef: intent,
        refundRef: null,
      });
    });
  });
});
