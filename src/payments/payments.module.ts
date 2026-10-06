import { Logger, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Stripe from 'stripe';

import { AsaasPaymentProvider } from './asaas-payment.provider';
import { FakePaymentProvider } from './fake-payment.provider';
import { HybridPaymentProvider } from './hybrid-payment.provider';
import { MercadoPagoPaymentProvider } from './mercadopago-payment.provider';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider';
import {
  isStripeConfigured,
  STRIPE_CLIENT,
  stripeClientProvider,
} from './stripe-client';
import { StripePaymentProvider } from './stripe-payment.provider';

/**
 * Environments where falling back to the fake is a convenience rather than a
 * hole. Anything else — including NODE_ENV being unset — is treated as real.
 */
const FAKE_PAYMENTS_ALLOWED = new Set(['development', 'test']);

/**
 * Returns true when ASAAS_API_KEY and ASAAS_WEBHOOK_SECRET are both present.
 * Both or neither: a key without a secret charges money and can never confirm
 * it arrived.
 */
function isAsaasConfigured(config: ConfigService): boolean {
  return Boolean(
    config.get<string>('ASAAS_API_KEY') &&
    config.get<string>('ASAAS_WEBHOOK_SECRET'),
  );
}

/**
 * Returns true when MERCADOPAGO_ACCESS_TOKEN and MERCADOPAGO_WEBHOOK_SECRET
 * are both present.
 */
function isMercadoPagoConfigured(config: ConfigService): boolean {
  return Boolean(
    config.get<string>('MERCADOPAGO_ACCESS_TOKEN') &&
    config.get<string>('MERCADOPAGO_WEBHOOK_SECRET'),
  );
}

/**
 * Resolves which concrete providers to bind under the PAYMENT_PROVIDER token.
 *
 * When all three gateways are configured, a HybridPaymentProvider is returned
 * that routes PIX to Asaas, card to Mercado Pago, and Stripe as fallback.
 *
 * When only some gateways are configured, the hybrid still wires up what it
 * has and falls back to FakePaymentProvider for the rest — this lets the store
 * work during a partial migration.
 *
 * The production guard remains: if NODE_ENV is not 'development' or 'test' and
 * no real gateway is configured, the app refuses to boot.
 */
export function resolvePaymentProvider(
  config: ConfigService,
  stripe: Stripe | null,
): PaymentProvider {
  const environment = config.get<string>('NODE_ENV')?.trim().toLowerCase();
  const asaasCfg = isAsaasConfigured(config);
  const mpCfg = isMercadoPagoConfigured(config);
  const stripeCfg = stripe && isStripeConfigured(config);
  const anyReal = asaasCfg || mpCfg || stripeCfg;

  if (!anyReal) {
    if (!environment || !FAKE_PAYMENTS_ALLOWED.has(environment)) {
      throw new Error(
        'No payment gateway is fully configured. At least one of (ASAAS_API_KEY + ASAAS_WEBHOOK_SECRET), ' +
          '(MERCADOPAGO_ACCESS_TOKEN + MERCADOPAGO_WEBHOOK_SECRET), or (STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET) ' +
          `is required unless NODE_ENV is 'development' or 'test' ` +
          `(NODE_ENV is ${environment ? `'${environment}'` : 'unset'}).`,
      );
    }

    new Logger('PaymentsModule').warn(
      'No payment gateway is configured; using FakePaymentProvider for all methods. ' +
        'No money will move, and the webhook routes accept unsigned events.',
    );

    return new FakePaymentProvider(config);
  }

  // Build a fake as the baseline for any unconfirmed gateway.
  const fakeProvider = new FakePaymentProvider(config);

  const asaasProvider: PaymentProvider = asaasCfg
    ? new AsaasPaymentProvider(config)
    : fakeProvider;

  const mpProvider: PaymentProvider = mpCfg
    ? new MercadoPagoPaymentProvider(config)
    : fakeProvider;

  let stripeProvider: PaymentProvider;

  if (stripeCfg) {
    stripeProvider = new StripePaymentProvider(stripe, config);
  } else {
    new Logger('PaymentsModule').warn(
      'Stripe is not configured; Stripe-method payments will use FakePaymentProvider.',
    );
    stripeProvider = fakeProvider;
  }

  return new HybridPaymentProvider(asaasProvider, mpProvider, stripeProvider);
}

const paymentProvider: Provider = {
  provide: PAYMENT_PROVIDER,
  inject: [ConfigService, STRIPE_CLIENT],
  useFactory: resolvePaymentProvider,
};

/**
 * Owns the gateway layer and nothing else (docs/architecture/modules.md):
 * the PaymentProvider token with a HybridPaymentProvider behind it that
 * routes by method (PIX → Asaas, CREDIT_CARD → Mercado Pago, STRIPE → Stripe).
 *
 * Not @Global on purpose — only orders charges money, and importing this module
 * is how that dependency stays visible in the module graph. No controller and no
 * database access live here: reacting to a payment is a change to an ORDER, so
 * those handlers live in `orders` and this module never learns that orders exist.
 */
@Module({
  providers: [stripeClientProvider, paymentProvider],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentsModule {}
