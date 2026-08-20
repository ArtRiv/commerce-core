import { Logger, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  SHIPPING_DEFAULT_WEIGHT_GRAMS,
  SHIPPING_PROVIDER,
  type ShippingProvider,
} from './shipping-provider';
import {
  DEFAULT_SHIPPING_TABLE,
  parseShippingTable,
  type ShippingTableOption,
} from './shipping-table';
import { TableShippingProvider } from './table-shipping.provider';

/**
 * Environments where falling back to the built-in table is a convenience
 * rather than a hole — the same allow-list, for the same reason, as
 * resolvePaymentProvider. Anything else, NODE_ENV being unset included, is
 * treated as real.
 */
const CONFIGURED_TABLE_REQUIRED_UNLESS = new Set(['development', 'test']);

/** What a product with no weight of its own is assumed to weigh. */
const FALLBACK_WEIGHT_GRAMS = 500;

export function resolveShippingTable(
  config: ConfigService,
): readonly ShippingTableOption[] {
  const raw = config.get<string>('SHIPPING_TABLE')?.trim();

  if (raw) {
    // Throws — with the offending option named — and that failure is meant to
    // reach the boot. A table that cannot be trusted must not be half-applied.
    return parseShippingTable(raw);
  }

  const environment = config.get<string>('NODE_ENV')?.trim().toLowerCase();

  // Allow-list rather than deny-list, exactly as payments argues: the failure
  // mode of guessing wrong is a store charging invented freight on every
  // single order, and "NODE_ENV happened to be unset on this box" is not a
  // reason to start doing that quietly.
  if (!environment || !CONFIGURED_TABLE_REQUIRED_UNLESS.has(environment)) {
    throw new Error(
      "SHIPPING_TABLE is required unless NODE_ENV is 'development' or 'test' " +
        `(NODE_ENV is ${environment ? `'${environment}'` : 'unset'}) — refusing to start a ` +
        'store that would charge made-up freight on every order.',
    );
  }

  new Logger('ShippingModule').warn(
    'SHIPPING_TABLE is not set; using the built-in development freight table. ' +
      'Its prices are placeholders and must not be used to charge anyone.',
  );

  return DEFAULT_SHIPPING_TABLE;
}

export function resolveFreeAboveCents(config: ConfigService): number | null {
  const raw = config.get<string>('SHIPPING_FREE_ABOVE_CENTS')?.trim();

  if (!raw) {
    return null;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `SHIPPING_FREE_ABOVE_CENTS must be a whole number of cents (got ${JSON.stringify(raw)}).`,
    );
  }

  return parsed;
}

export function resolveDefaultWeightGrams(config: ConfigService): number {
  const raw = config.get<string>('SHIPPING_DEFAULT_WEIGHT_GRAMS')?.trim();

  if (!raw) {
    return FALLBACK_WEIGHT_GRAMS;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `SHIPPING_DEFAULT_WEIGHT_GRAMS must be a whole number of grams above 0 (got ${JSON.stringify(raw)}).`,
    );
  }

  return parsed;
}

const shippingProvider: Provider = {
  provide: SHIPPING_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService): ShippingProvider =>
    new TableShippingProvider(
      resolveShippingTable(config),
      resolveFreeAboveCents(config),
    ),
};

const defaultWeightGrams: Provider = {
  provide: SHIPPING_DEFAULT_WEIGHT_GRAMS,
  inject: [ConfigService],
  useFactory: resolveDefaultWeightGrams,
};

/**
 * Owns freight pricing and nothing else (docs/architecture/modules.md): the
 * ShippingProvider token with an adapter behind it, same shape as `payments`
 * and `mail`.
 *
 * A leaf of the module graph, and it has to stay one. It knows nothing about
 * carts, orders or products — orders reads the cart, resolves weights through
 * the catalog contract it already uses, and hands this module a request that
 * is complete. That is what keeps the arrow orders → shipping pointing one
 * way, and it is why the quote CONTROLLER lives in orders despite serving
 * /shipping/quote, exactly as the payment webhook does.
 *
 * Not @Global, for the same reason payments is not: only orders prices
 * freight, and importing the module is what keeps that visible in the graph.
 */
@Module({
  providers: [shippingProvider, defaultWeightGrams],
  exports: [SHIPPING_PROVIDER, SHIPPING_DEFAULT_WEIGHT_GRAMS],
})
export class ShippingModule {}
