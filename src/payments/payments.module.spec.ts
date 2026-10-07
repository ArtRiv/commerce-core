import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type Stripe from 'stripe';

import { FakePaymentProvider } from './fake-payment.provider';
import { HybridPaymentProvider } from './hybrid-payment.provider';
import { resolvePaymentProvider } from './payments.module';

function configWith(values: Record<string, string | undefined> = {}) {
  const settings: Record<string, string | undefined> = {
    APP_URL: 'http://localhost:5173',
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

const STRIPE_CONFIGURED = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
};

const ASAAS_CONFIGURED = {
  ASAAS_API_KEY: 'asaas_key',
  ASAAS_WEBHOOK_SECRET: 'asaas_secret',
};

const MP_CONFIGURED = {
  MERCADOPAGO_ACCESS_TOKEN: 'TEST-mp_token',
  MERCADOPAGO_WEBHOOK_SECRET: 'mp_secret',
};

const stripe = {} as Stripe;

describe('resolvePaymentProvider', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns HybridPaymentProvider when Stripe is configured', () => {
    expect(
      resolvePaymentProvider(configWith(STRIPE_CONFIGURED), stripe),
    ).toBeInstanceOf(HybridPaymentProvider);
  });

  it('returns HybridPaymentProvider when Asaas is configured', () => {
    expect(
      resolvePaymentProvider(configWith(ASAAS_CONFIGURED), null),
    ).toBeInstanceOf(HybridPaymentProvider);
  });

  it('returns HybridPaymentProvider when Mercado Pago is configured', () => {
    expect(
      resolvePaymentProvider(configWith(MP_CONFIGURED), null),
    ).toBeInstanceOf(HybridPaymentProvider);
  });

  it('returns HybridPaymentProvider when all three gateways are configured', () => {
    expect(
      resolvePaymentProvider(
        configWith({
          ...STRIPE_CONFIGURED,
          ...ASAAS_CONFIGURED,
          ...MP_CONFIGURED,
        }),
        stripe,
      ),
    ).toBeInstanceOf(HybridPaymentProvider);
  });

  it.each(['development', 'test'])(
    'falls back to FakePaymentProvider in %s when no gateway is configured, loudly',
    (environment) => {
      const provider = resolvePaymentProvider(
        configWith({ NODE_ENV: environment }),
        null,
      );

      expect(provider).toBeInstanceOf(FakePaymentProvider);
      expect(warn).toHaveBeenCalled();
    },
  );

  it('falls back to HybridPaymentProvider with partial Stripe in development (one key only)', () => {
    // One key is not enough — falls back to Fake for Stripe slot, but overall
    // resolves a Hybrid if any other gateway is configured; with none at all
    // and in dev → FakePaymentProvider.
    const provider = resolvePaymentProvider(
      configWith({ NODE_ENV: 'development', STRIPE_SECRET_KEY: 'sk_test_x' }),
      stripe,
    );

    // No complete gateway → FakePaymentProvider in dev.
    expect(provider).toBeInstanceOf(FakePaymentProvider);
  });

  it('refuses to boot in production without any gateway', () => {
    expect(() =>
      resolvePaymentProvider(configWith({ NODE_ENV: 'production' }), null),
    ).toThrow(/required unless NODE_ENV is/);
  });

  it.each([
    ['unset', undefined],
    ['staging', 'staging'],
    ['Production (wrong case)', 'Production'],
    ['prod', 'prod'],
  ])(
    'refuses to boot with NODE_ENV %s rather than silently faking payments',
    (_label, environment) => {
      // The fake's webhook does NO signature verification — the body IS the
      // event — so anyone who can reach /payments/webhook could mark orders
      // paid. An allow-list means an unset or misspelled NODE_ENV fails closed
      // instead of opening that route on a real deployment.
      expect(() =>
        resolvePaymentProvider(configWith({ NODE_ENV: environment }), null),
      ).toThrow(/required unless NODE_ENV is/);
    },
  );

  it('still accepts an explicitly cased or padded development value', () => {
    expect(
      resolvePaymentProvider(configWith({ NODE_ENV: ' Development ' }), null),
    ).toBeInstanceOf(FakePaymentProvider);
  });

  it('still returns HybridPaymentProvider in production when Stripe is configured', () => {
    expect(
      resolvePaymentProvider(
        configWith({ ...STRIPE_CONFIGURED, NODE_ENV: 'production' }),
        stripe,
      ),
    ).toBeInstanceOf(HybridPaymentProvider);
  });
});
