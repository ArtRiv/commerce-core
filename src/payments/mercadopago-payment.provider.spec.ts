import { createHmac } from 'node:crypto';

import { ConfigService } from '@nestjs/config';

import { MercadoPagoPaymentProvider } from './mercadopago-payment.provider';

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    MERCADOPAGO_ACCESS_TOKEN: 'TEST-abc123',
    MERCADOPAGO_WEBHOOK_SECRET: 'mp-secret',
    APP_URL: 'http://localhost:5173',
    ...overrides,
  };
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error(`Missing config: ${key}`);
      return values[key];
    },
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

function makeSignature(secret: string, requestId: string, ts: string): string {
  const signedData = `id:${requestId};request-id:${requestId};ts:${ts};`;
  return createHmac('sha256', secret).update(signedData).digest('hex');
}

describe('MercadoPagoPaymentProvider', () => {
  let provider: MercadoPagoPaymentProvider;

  beforeEach(() => {
    provider = new MercadoPagoPaymentProvider(makeConfig());
  });

  describe('parseEvent', () => {
    it('accepts a valid HMAC signature and returns payment.succeeded for payment events', () => {
      const ts = String(Date.now());
      const requestId = 'req-abc-123';
      const v1 = makeSignature('mp-secret', requestId, ts);

      const payload = {
        type: 'payment',
        id: 'evt_1',
        data: { id: 'pay_789', external_reference: 'order-def' },
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const headers = {
        'x-signature': `ts=${ts},v1=${v1}`,
        'x-request-id': requestId,
      };

      const event = provider.parseEvent(rawBody, headers) as any;

      expect(event.type).toBe('payment.succeeded');
      expect(event.providerType).toBe('payment');
      expect(event.paymentIntentRef).toBe('mp_pay_789');
    });

    it('returns ignored for non-payment events', () => {
      const ts = String(Date.now());
      const requestId = 'req-xyz';
      const v1 = makeSignature('mp-secret', requestId, ts);

      const payload = {
        type: 'subscription',
        id: 'sub_1',
        data: { id: 'sub_1' },
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const headers = {
        'x-signature': `ts=${ts},v1=${v1}`,
        'x-request-id': requestId,
      };

      const event = provider.parseEvent(rawBody, headers);
      expect(event.type).toBe('ignored');
    });

    it('rejects missing x-signature header', () => {
      const rawBody = Buffer.from('{}');
      expect(() =>
        provider.parseEvent(rawBody, { 'x-request-id': 'req-1' }),
      ).toThrow('Missing x-signature header');
    });

    it('rejects malformed x-signature (missing ts)', () => {
      const rawBody = Buffer.from('{}');
      expect(() =>
        provider.parseEvent(rawBody, {
          'x-signature': 'v1=abc',
          'x-request-id': 'req-1',
        }),
      ).toThrow('Malformed x-signature header');
    });

    it('rejects a signature with the wrong HMAC (same length)', () => {
      const ts = String(Date.now());
      const rawBody = Buffer.from('{}');
      // SHA-256 output is 32 bytes = 64 hex chars. Use a plausible-looking but wrong value.
      const wrongHmac = 'a'.repeat(64);
      expect(() =>
        provider.parseEvent(rawBody, {
          'x-signature': `ts=${ts},v1=${wrongHmac}`,
          'x-request-id': 'req-1',
        }),
      ).toThrow('Invalid Mercado Pago webhook signature');
    });

    it('rejects a signature with a different-length HMAC', () => {
      const ts = String(Date.now());
      const rawBody = Buffer.from('{}');
      expect(() =>
        provider.parseEvent(rawBody, {
          'x-signature': `ts=${ts},v1=tooshort`,
          'x-request-id': 'req-1',
        }),
      ).toThrow('Invalid Mercado Pago webhook signature');
    });
  });
});
