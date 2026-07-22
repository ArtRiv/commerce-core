import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConfigService } from '@nestjs/config';
import { parse } from 'dotenv';
import Stripe from 'stripe';

import { StripePaymentProvider } from '../src/payments/stripe-payment.provider';

/**
 * The one test that talks to real Stripe.
 *
 * Everything else in the suite proves our code does what we think; this proves
 * Stripe AGREES — that the session parameters we send are accepted, not just
 * well-formed by our lights. A wrong field or a disallowed combination is a 400
 * from Stripe, and the only place that surfaces is here or in production.
 *
 * It reads the key from the .env FILE rather than process.env on purpose: the
 * offline suites force STRIPE_SECRET_KEY to a sentinel at app boot, and reading
 * the file sidesteps that contamination. With no real key present it skips
 * entirely, so CI and a fresh clone stay green and offline.
 *
 * Run it deliberately: `npm run test:e2e -- payments-live`. It creates test-mode
 * Checkout Sessions in the configured account and moves no money.
 */
function loadEnvFile(): Record<string, string> {
  try {
    return parse(readFileSync(join(__dirname, '..', '.env')));
  } catch {
    return {};
  }
}

const env: Record<string, string | undefined> = loadEnvFile();
const secretKey = env.STRIPE_SECRET_KEY;
const isLive = Boolean(
  secretKey && secretKey.startsWith('sk_') && secretKey !== 'sk_test_offline',
);

// describe.skip keeps the suite green and clearly reported as skipped when no
// real key is configured, rather than silently absent.
const describeLive = isLive ? describe : describe.skip;

function configFromEnv(): ConfigService {
  const settings: Record<string, string | undefined> = {
    APP_URL: env.APP_URL ?? 'http://localhost:5173',
    STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET ?? 'whsec_unused_here',
    STRIPE_CURRENCY: env.STRIPE_CURRENCY,
    STRIPE_CHECKOUT_MODE: env.STRIPE_CHECKOUT_MODE,
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

describeLive('Payments (live Stripe)', () => {
  let provider: StripePaymentProvider;

  beforeAll(() => {
    const stripe = new Stripe(secretKey ?? '', { maxNetworkRetries: 2 });
    provider = new StripePaymentProvider(stripe, configFromEnv());
  });

  it('creates a hosted session Stripe accepts', async () => {
    const session = await provider.createPayment({
      orderId: `live-hosted-${String(Date.now())}`,
      amountCents: 4990,
      mode: 'hosted',
    });

    expect(session.providerRef).toMatch(/^cs_/);
    expect(session.url).toContain('https://');
    expect(session.clientSecret).toBeNull();
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('creates an embedded session Stripe accepts', async () => {
    // The embedded parameters — return_url required, success_url/cancel_url
    // forbidden — are a different set Stripe never sees in the offline suite.
    // This is the assertion that would have caught a wrong one.
    const session = await provider.createPayment({
      orderId: `live-embedded-${String(Date.now())}`,
      amountCents: 4990,
      mode: 'embedded',
    });

    expect(session.providerRef).toMatch(/^cs_/);
    expect(session.clientSecret).toMatch(/_secret_/);
    expect(session.url).toBeNull();
  });
});
