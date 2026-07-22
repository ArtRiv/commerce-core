import { Logger, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Stripe from 'stripe';

import { FakePaymentProvider } from './fake-payment.provider';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider';
import {
  isStripeConfigured,
  STRIPE_CLIENT,
  stripeClientProvider,
} from './stripe-client';
import { StripePaymentProvider } from './stripe-payment.provider';

/**
 * Stripe when configured, the fake when not — and never the fake in production.
 *
 * The middle case is the point: cloning this repo without a Stripe account
 * still gives a checkout that works end to end, the same courtesy auth extends
 * for Google sign-in. The production guard is what keeps that courtesy from
 * becoming a disaster, because a deploy that quietly stops charging money is a
 * worse failure than one that refuses to boot.
 */
export function resolvePaymentProvider(
  config: ConfigService,
  stripe: Stripe | null,
): PaymentProvider {
  if (stripe && isStripeConfigured(config)) {
    return new StripePaymentProvider(stripe, config);
  }

  if (config.get<string>('NODE_ENV') === 'production') {
    throw new Error(
      'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required in production — ' +
        'refusing to start a store that cannot charge anyone.',
    );
  }

  new Logger('PaymentsModule').warn(
    'Stripe is not configured; using FakePaymentProvider. No money will move, ' +
      'and the webhook route accepts unsigned events.',
  );

  return new FakePaymentProvider(config);
}

const paymentProvider: Provider = {
  provide: PAYMENT_PROVIDER,
  inject: [ConfigService, STRIPE_CLIENT],
  useFactory: resolvePaymentProvider,
};

/**
 * Owns the gateway and nothing else (docs/architecture/modules.md): the
 * PaymentProvider token with an adapter behind it, same shape as `mail`.
 *
 * Not @Global on purpose — only orders charges money, and importing this module
 * is how that dependency stays visible in the module graph. Note what is NOT
 * here: no controller and no database access. Reacting to a payment is a change
 * to an ORDER, so that handler lives in `orders` and this module never learns
 * that orders exist. That is what keeps the arrow pointing one way.
 */
@Module({
  providers: [stripeClientProvider, paymentProvider],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentsModule {}
