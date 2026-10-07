import { HybridPaymentProvider } from './hybrid-payment.provider';
import type {
  CreatePaymentInput,
  PaymentEvent,
  PaymentProvider,
  PaymentSession,
  WebhookHeaders,
} from './payment-provider';

/** Minimal stub for a payment provider. */
function makeStub(
  name: string,
  overrides: Partial<PaymentProvider> = {},
): jest.Mocked<PaymentProvider> {
  const session: PaymentSession = {
    providerRef: `${name}_ref_1`,
    mode: 'hosted',
    url: `https://${name}.example.com`,
    clientSecret: null,
    expiresAt: new Date(Date.now() + 86400000),
  };

  return {
    createPayment: jest.fn().mockResolvedValue(session),
    getPayment: jest.fn().mockResolvedValue({ state: 'open', session }),
    expirePayment: jest.fn().mockResolvedValue(undefined),
    refund: jest.fn().mockResolvedValue({ refundRef: `${name}_re_1` }),
    parseEvent: jest.fn().mockReturnValue({
      id: `${name}_evt_1`,
      type: 'ignored',
      providerType: `${name}.event`,
    } satisfies PaymentEvent),
    ...overrides,
  } as unknown as jest.Mocked<PaymentProvider>;
}

describe('HybridPaymentProvider', () => {
  let asaas: jest.Mocked<PaymentProvider>;
  let mercadoPago: jest.Mocked<PaymentProvider>;
  let stripe: jest.Mocked<PaymentProvider>;
  let hybrid: HybridPaymentProvider;

  beforeEach(() => {
    asaas = makeStub('asaas');
    mercadoPago = makeStub('mp');
    stripe = makeStub('stripe');
    hybrid = new HybridPaymentProvider(asaas, mercadoPago, stripe);
  });

  describe('createPayment', () => {
    it('routes PIX to Asaas', async () => {
      const input: CreatePaymentInput = {
        orderId: 'order-1',
        amountCents: 5000,
        method: 'PIX',
      };
      await hybrid.createPayment(input);
      expect(asaas.createPayment).toHaveBeenCalledWith(input);
      expect(mercadoPago.createPayment).not.toHaveBeenCalled();
      expect(stripe.createPayment).not.toHaveBeenCalled();
    });

    it('routes CREDIT_CARD to Mercado Pago', async () => {
      const input: CreatePaymentInput = {
        orderId: 'order-2',
        amountCents: 10000,
        method: 'CREDIT_CARD',
      };
      await hybrid.createPayment(input);
      expect(mercadoPago.createPayment).toHaveBeenCalledWith(input);
      expect(asaas.createPayment).not.toHaveBeenCalled();
      expect(stripe.createPayment).not.toHaveBeenCalled();
    });

    it('routes STRIPE to the Stripe provider', async () => {
      const input: CreatePaymentInput = {
        orderId: 'order-3',
        amountCents: 8000,
        method: 'STRIPE',
      };
      await hybrid.createPayment(input);
      expect(stripe.createPayment).toHaveBeenCalledWith(input);
      expect(asaas.createPayment).not.toHaveBeenCalled();
      expect(mercadoPago.createPayment).not.toHaveBeenCalled();
    });

    it('routes undefined method to Stripe (default)', async () => {
      const input: CreatePaymentInput = {
        orderId: 'order-4',
        amountCents: 3000,
      };
      await hybrid.createPayment(input);
      expect(stripe.createPayment).toHaveBeenCalledWith(input);
    });
  });

  describe('getPayment', () => {
    it('routes asaas_ prefixed ref to Asaas', async () => {
      await hybrid.getPayment('asaas_pay_123');
      expect(asaas.getPayment).toHaveBeenCalledWith('asaas_pay_123');
    });

    it('routes mp_ prefixed ref to Mercado Pago', async () => {
      await hybrid.getPayment('mp_pref_456');
      expect(mercadoPago.getPayment).toHaveBeenCalledWith('mp_pref_456');
    });

    it('routes cs_ prefixed ref to Stripe', async () => {
      await hybrid.getPayment('cs_test_abc');
      expect(stripe.getPayment).toHaveBeenCalledWith('cs_test_abc');
    });

    it('routes fake_ prefixed ref to Stripe slot (FakePaymentProvider)', async () => {
      await hybrid.getPayment('fake_cs_xyz');
      expect(stripe.getPayment).toHaveBeenCalledWith('fake_cs_xyz');
    });
  });

  describe('expirePayment', () => {
    it('routes asaas_ to Asaas', async () => {
      await hybrid.expirePayment('asaas_pay_999');
      expect(asaas.expirePayment).toHaveBeenCalledWith('asaas_pay_999');
    });

    it('routes mp_ to Mercado Pago', async () => {
      await hybrid.expirePayment('mp_pref_999');
      expect(mercadoPago.expirePayment).toHaveBeenCalledWith('mp_pref_999');
    });
  });

  describe('refund', () => {
    it('routes asaas_ payment intent to Asaas', async () => {
      await hybrid.refund({ paymentIntentRef: 'asaas_pay_777' });
      expect(asaas.refund).toHaveBeenCalledWith({
        paymentIntentRef: 'asaas_pay_777',
      });
    });

    it('routes mp_ payment intent to Mercado Pago', async () => {
      await hybrid.refund({ paymentIntentRef: 'mp_pay_888' });
      expect(mercadoPago.refund).toHaveBeenCalledWith({
        paymentIntentRef: 'mp_pay_888',
      });
    });

    it('routes pi_ (Stripe intent) to Stripe', async () => {
      await hybrid.refund({ paymentIntentRef: 'pi_test_123' });
      expect(stripe.refund).toHaveBeenCalledWith({
        paymentIntentRef: 'pi_test_123',
      });
    });
  });

  describe('parseEvent', () => {
    const rawBody = Buffer.from('{}');

    it('dispatches to Asaas when asaas-access-token header is present', () => {
      const headers: WebhookHeaders = { 'asaas-access-token': 'token123' };
      hybrid.parseEvent(rawBody, headers);
      expect(asaas.parseEvent).toHaveBeenCalledWith(rawBody, headers);
      expect(mercadoPago.parseEvent).not.toHaveBeenCalled();
      expect(stripe.parseEvent).not.toHaveBeenCalled();
    });

    it('dispatches to Mercado Pago when x-signature header is present', () => {
      const headers: WebhookHeaders = { 'x-signature': 'ts=123,v1=abc' };
      hybrid.parseEvent(rawBody, headers);
      expect(mercadoPago.parseEvent).toHaveBeenCalledWith(rawBody, headers);
      expect(asaas.parseEvent).not.toHaveBeenCalled();
      expect(stripe.parseEvent).not.toHaveBeenCalled();
    });

    it('dispatches to Stripe when no special header is present', () => {
      const headers: WebhookHeaders = { 'stripe-signature': 'v1=abc,t=123' };
      hybrid.parseEvent(rawBody, headers);
      expect(stripe.parseEvent).toHaveBeenCalledWith(rawBody, headers);
      expect(asaas.parseEvent).not.toHaveBeenCalled();
      expect(mercadoPago.parseEvent).not.toHaveBeenCalled();
    });

    it('dispatches to Stripe for empty headers (fallback)', () => {
      hybrid.parseEvent(rawBody, {});
      expect(stripe.parseEvent).toHaveBeenCalledWith(rawBody, {});
    });
  });
});
