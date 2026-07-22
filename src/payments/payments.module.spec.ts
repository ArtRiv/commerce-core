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

  it('falls back to the fake outside production, loudly', () => {
    const provider = resolvePaymentProvider(configWith(), null);

    expect(provider).toBeInstanceOf(FakePaymentProvider);
    expect(warn).toHaveBeenCalled();
  });

  it('refuses the fake when only one of the two variables is set', () => {
    // A secret key with no webhook secret charges people and can never confirm
    // it did — the fake is the safer of two bad options outside production.
    const provider = resolvePaymentProvider(
      configWith({ STRIPE_SECRET_KEY: 'sk_test_x' }),
      stripe,
    );

    expect(provider).toBeInstanceOf(FakePaymentProvider);
  });

  it('refuses to boot in production without Stripe', () => {
    expect(() =>
      resolvePaymentProvider(configWith({ NODE_ENV: 'production' }), null),
    ).toThrow(/required in production/);
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
