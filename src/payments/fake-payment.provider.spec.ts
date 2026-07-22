import type { ConfigService } from '@nestjs/config';

import { FakePaymentProvider } from './fake-payment.provider';

const APP_URL = 'http://localhost:5173';

function providerWith(values: Record<string, string> = {}) {
  const settings: Record<string, string> = { APP_URL, ...values };

  return new FakePaymentProvider({
    get: (key: string) => settings[key],
  } as unknown as ConfigService);
}

function createInput(overrides: Record<string, unknown> = {}) {
  return { orderId: 'order-1', amountCents: 4500, ...overrides };
}

describe('FakePaymentProvider', () => {
  describe('createPayment', () => {
    it('acknowledges every payment with a unique fake reference', async () => {
      const provider = providerWith();

      const first = await provider.createPayment(createInput());
      const second = await provider.createPayment(
        createInput({ orderId: 'order-2' }),
      );

      expect(first.providerRef).toMatch(/^fake_cs_/);
      // Unique per call: paymentRef distinguishes orders, so a constant would
      // silently break any reconciliation-by-reference.
      expect(first.providerRef).not.toBe(second.providerRef);
    });

    it('answers hosted with a url and embedded with a client secret', async () => {
      const provider = providerWith();

      const hosted = await provider.createPayment(
        createInput({ mode: 'hosted' }),
      );
      const embedded = await provider.createPayment(
        createInput({ orderId: 'order-2', mode: 'embedded' }),
      );

      expect(hosted.url).toContain(APP_URL);
      expect(hosted.clientSecret).toBeNull();
      expect(embedded.url).toBeNull();
      expect(embedded.clientSecret).toContain(embedded.providerRef);
    });

    it('honours the configured default mode', async () => {
      const session = await providerWith({
        STRIPE_CHECKOUT_MODE: 'embedded',
      }).createPayment(createInput());

      expect(session.mode).toBe('embedded');
    });
  });

  describe('getPayment', () => {
    it('returns a session it issued, so /pay can reuse instead of duplicating', async () => {
      const provider = providerWith();
      const created = await provider.createPayment(createInput());

      await expect(provider.getPayment(created.providerRef)).resolves.toEqual(
        created,
      );
    });

    it('returns null for an unknown or expired reference', async () => {
      const provider = providerWith();
      const created = await provider.createPayment(createInput());

      await expect(provider.getPayment('fake_cs_nope')).resolves.toBeNull();

      await provider.expirePayment(created.providerRef);
      await expect(
        provider.getPayment(created.providerRef),
      ).resolves.toBeNull();
    });
  });

  describe('refund', () => {
    it('returns a unique fake refund reference', async () => {
      const provider = providerWith();

      const first = await provider.refund();
      const second = await provider.refund();

      expect(first.refundRef).toMatch(/^fake_re_/);
      expect(first.refundRef).not.toBe(second.refundRef);
    });
  });

  describe('parseEvent', () => {
    it('reads an unsigned domain event straight from the body', () => {
      const event = {
        id: 'evt_local_1',
        type: 'payment.succeeded',
        orderId: 'order-1',
        paymentIntentRef: 'fake_pi_1',
      };

      // With no separate provider vocabulary, the domain type doubles as the
      // audit label.
      expect(
        providerWith().parseEvent(Buffer.from(JSON.stringify(event))),
      ).toEqual({ ...event, providerType: 'payment.succeeded' });
    });

    it('carries an explicit providerType through when one is given', () => {
      const event = {
        id: 'evt_local_2',
        providerType: 'charge.refunded',
        type: 'payment.refunded',
        orderId: 'order-1',
        paymentIntentRef: 'fake_pi_1',
        refundRef: 'fake_re_1',
      };

      expect(
        providerWith().parseEvent(Buffer.from(JSON.stringify(event))),
      ).toEqual(event);
    });

    it('rejects a body that is not a domain event', () => {
      const provider = providerWith();

      // The webhook route must still be able to answer 400, or the failure
      // path it shares with the real provider would go untested locally.
      expect(() => provider.parseEvent(Buffer.from('not json'))).toThrow();
      expect(() =>
        provider.parseEvent(Buffer.from('{"nothing":"useful"}')),
      ).toThrow();
    });
  });
});
