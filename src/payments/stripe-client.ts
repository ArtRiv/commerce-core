import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

/**
 * The Stripe SDK client, injected rather than constructed inside the adapter.
 *
 * This is what makes StripePaymentProvider testable: unit tests hand it a stub
 * and assert the session parameters, and the e2e suite replaces only the calls
 * that reach the network — leaving webhooks.constructEvent, the real signature
 * verification, running against payloads the test signs itself. A client built
 * inside the adapter would make both of those impossible without a network.
 */
export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');

/**
 * Both variables or neither. A secret key without a webhook secret is the
 * worst of the three states: it charges people and can never confirm that it
 * did, because every event it receives fails verification. Same all-or-nothing
 * rule as Google OAuth's id/secret pair in auth.
 */
export function isStripeConfigured(config: ConfigService): boolean {
  return Boolean(
    config.get<string>('STRIPE_SECRET_KEY') &&
    config.get<string>('STRIPE_WEBHOOK_SECRET'),
  );
}

/**
 * Null when Stripe is not configured — PaymentsModule reads that as "bind the
 * fake instead", which is legal everywhere except production.
 *
 * No apiVersion is pinned here: the option's type only admits the SDK's own
 * latest version, so naming it would break the build on the next bump without
 * buying anything. The installed SDK version is the pin.
 */
export const stripeClientProvider: Provider = {
  provide: STRIPE_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Stripe | null =>
    isStripeConfigured(config)
      ? new Stripe(config.getOrThrow<string>('STRIPE_SECRET_KEY'), {
          // The SDK retries transient network failures itself, generating and
          // reusing an idempotency key across those attempts. That is why this
          // module hand-rolls no key: the retry that needs one happens in
          // here, while a retry a human asked for (a second /orders/:id/pay)
          // genuinely wants to be a fresh request.
          maxNetworkRetries: 2,
        })
      : null,
};
