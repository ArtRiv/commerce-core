import { ConfigService } from '@nestjs/config';

import { AsaasPaymentProvider } from './asaas-payment.provider';

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    ASAAS_API_KEY: 'test-api-key',
    ASAAS_WEBHOOK_SECRET: 'test-secret-token',
    ASAAS_BASE_URL: 'https://sandbox.asaas.com/api/v3',
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

describe('AsaasPaymentProvider', () => {
  let provider: AsaasPaymentProvider;

  beforeEach(() => {
    provider = new AsaasPaymentProvider(makeConfig());
  });

  describe('parseEvent', () => {
    it('accepts a valid token and returns payment.succeeded for PAYMENT_RECEIVED', () => {
      const payload = {
        event: 'PAYMENT_RECEIVED',
        payment: {
          id: 'pay_123',
          externalReference: 'order-abc',
          status: 'RECEIVED',
        },
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const headers = { 'asaas-access-token': 'test-secret-token' };

      const event = provider.parseEvent(rawBody, headers) as any;

      expect(event.type).toBe('payment.succeeded');
      expect(event.providerType).toBe('PAYMENT_RECEIVED');
      expect(event.orderId).toBe('order-abc');
      expect(event.paymentIntentRef).toBe('asaas_pay_123');
    });

    it('accepts PAYMENT_CONFIRMED and returns payment.succeeded', () => {
      const payload = {
        event: 'PAYMENT_CONFIRMED',
        payment: { id: 'pay_456', externalReference: 'order-xyz' },
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const headers = { 'asaas-access-token': 'test-secret-token' };

      const event = provider.parseEvent(rawBody, headers);
      expect(event.type).toBe('payment.succeeded');
    });

    it('returns payment.refunded for PAYMENT_REFUNDED', () => {
      const payload = {
        event: 'PAYMENT_REFUNDED',
        payment: { id: 'pay_789', externalReference: 'order-qrs' },
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const headers = { 'asaas-access-token': 'test-secret-token' };

      const event = provider.parseEvent(rawBody, headers);
      expect(event.type).toBe('payment.refunded');
    });

    it('returns payment.expired for PAYMENT_OVERDUE', () => {
      const payload = {
        event: 'PAYMENT_OVERDUE',
        payment: { id: 'pay_000', externalReference: 'order-zzz' },
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const headers = { 'asaas-access-token': 'test-secret-token' };

      const event = provider.parseEvent(rawBody, headers);
      expect(event.type).toBe('payment.expired');
    });

    it('returns ignored for unknown event types', () => {
      const payload = {
        event: 'CUSTOMER_CREATED',
        payment: { id: 'pay_111', externalReference: 'order-aaa' },
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const headers = { 'asaas-access-token': 'test-secret-token' };

      const event = provider.parseEvent(rawBody, headers);
      expect(event.type).toBe('ignored');
    });

    it('rejects missing token header', () => {
      const rawBody = Buffer.from('{}');
      expect(() => provider.parseEvent(rawBody, {})).toThrow(
        'Missing asaas-access-token header',
      );
    });

    it('rejects invalid token', () => {
      const rawBody = Buffer.from('{}');
      const headers = { 'asaas-access-token': 'wrong-token' };
      expect(() => provider.parseEvent(rawBody, headers)).toThrow(
        'Invalid Asaas webhook token',
      );
    });

    it('uses timing-safe comparison (same length wrong token)', () => {
      const rawBody = Buffer.from('{}');
      // Same length as 'test-secret-token' (17 chars) but different value.
      const headers = { 'asaas-access-token': 'test-WRONG-token!' };
      expect(() => provider.parseEvent(rawBody, headers)).toThrow(
        'Invalid Asaas webhook token',
      );
    });
  });
});
