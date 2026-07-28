import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type Stripe from 'stripe';

import { FakePaymentProvider } from './fake-payment.provider';
import { resolvePaymentProvider } from './payments.module';
import { StripePaymentProvider } from './stripe-payment.provider';

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

const CONFIGURED = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
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

  it('binds Stripe when both variables are present', () => {
    expect(
      resolvePaymentProvider(configWith(CONFIGURED), stripe),
    ).toBeInstanceOf(StripePaymentProvider);
  });

  it.each(['development', 'test'])(
    'falls back to the fake in %s, loudly',
    (environment) => {
      const provider = resolvePaymentProvider(
        configWith({ NODE_ENV: environment }),
        null,
      );

      expect(provider).toBeInstanceOf(FakePaymentProvider);
      expect(warn).toHaveBeenCalled();
    },
  );

  it('refuses the fake when only one of the two variables is set', () => {
    // A secret key with no webhook secret charges people and can never confirm
    // it did — the fake is the safer of two bad options in development.
    const provider = resolvePaymentProvider(
      configWith({ NODE_ENV: 'development', STRIPE_SECRET_KEY: 'sk_test_x' }),
      stripe,
    );

    expect(provider).toBeInstanceOf(FakePaymentProvider);
  });

  it('refuses to boot in production without Stripe', () => {
    expect(() =>
      resolvePaymentProvider(configWith({ NODE_ENV: 'production' }), null),
    ).toThrow(/STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required/);
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

  it('still binds Stripe in production when it is configured', () => {
    expect(
      resolvePaymentProvider(
        configWith({ ...CONFIGURED, NODE_ENV: 'production' }),
        stripe,
      ),
    ).toBeInstanceOf(StripePaymentProvider);
  });
});
