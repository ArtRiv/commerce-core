import { Logger, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CepService } from './cep.service';
import { HybridShippingProvider } from './hybrid-shipping.provider';
import { MelhorEnvioShippingProvider } from './melhor-envio-shipping.provider';
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

/** Melhor Envio production API base URL. */
const MELHOR_ENVIO_BASE_URL = 'https://melhorenvio.com.br/api';

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

/**
 * Resolves the concrete ShippingProvider to bind to the SHIPPING_PROVIDER token.
 *
 * - MELHOR_ENVIO_TOKEN set → HybridShippingProvider (Melhor Envio primary +
 *   TableShippingProvider fallback). Both MELHOR_ENVIO_TOKEN and
 *   MELHOR_ENVIO_ORIGIN_CEP must be present; one without the other refuses boot,
 *   same logic as the payment gateways.
 * - MELHOR_ENVIO_TOKEN absent in development/test → TableShippingProvider with
 *   a warning.
 * - MELHOR_ENVIO_TOKEN absent in production → boot failure.
 */
export function resolveShippingProvider(
  config: ConfigService,
): ShippingProvider {
  const token = config.get<string>('MELHOR_ENVIO_TOKEN')?.trim();
  const originCep = config.get<string>('MELHOR_ENVIO_ORIGIN_CEP')?.trim();
  const environment = config.get<string>('NODE_ENV')?.trim().toLowerCase();
  const baseUrl =
    config.get<string>('MELHOR_ENVIO_BASE_URL')?.trim() ??
    MELHOR_ENVIO_BASE_URL;

  const table = resolveShippingTable(config);
  const freeAbove = resolveFreeAboveCents(config);
  const tableProvider = new TableShippingProvider(table, freeAbove);

  if (token && originCep) {
    const me = new MelhorEnvioShippingProvider(token, originCep, baseUrl);
    new Logger('ShippingModule').log(
      `Usando Melhor Envio para cotações em tempo real (origem: ${originCep}).`,
    );
    return new HybridShippingProvider(me, tableProvider);
  }

  if (token && !originCep) {
    throw new Error(
      'MELHOR_ENVIO_TOKEN está configurado mas MELHOR_ENVIO_ORIGIN_CEP está ausente. ' +
        'O CEP de origem é obrigatório para cotação de frete — configure-o com o CEP do seu centro de distribuição.',
    );
  }

  // No token — allow in dev/test, fail in production.
  const isDev = environment === 'development' || environment === 'test';

  if (!isDev) {
    throw new Error(
      'MELHOR_ENVIO_TOKEN é obrigatório em produção. ' +
        'Configure o token de acesso do Melhor Envio ou defina NODE_ENV como development para usar a tabela offline.',
    );
  }

  new Logger('ShippingModule').warn(
    'MELHOR_ENVIO_TOKEN não configurado — usando tabela de frete offline (desenvolvimento). ' +
      'Preços são placeholders e não devem ser cobrados de clientes reais.',
  );
  return tableProvider;
}

import { FakeShippingLabelService } from './fake-shipping-label.service';
import {
  SHIPPING_LABEL_SERVICE,
  type ShippingLabelProvider,
  ShippingLabelService,
} from './shipping-label.service';

export function resolveShippingLabelService(
  config: ConfigService,
): ShippingLabelProvider {
  const token = config.get<string>('MELHOR_ENVIO_TOKEN')?.trim();
  const environment = config.get<string>('NODE_ENV')?.trim().toLowerCase();
  const baseUrl =
    config.get<string>('MELHOR_ENVIO_BASE_URL')?.trim() ??
    MELHOR_ENVIO_BASE_URL;

  if (token) {
    return new ShippingLabelService(token, baseUrl);
  }

  const isDev = environment === 'development' || environment === 'test';
  if (!isDev) {
    throw new Error(
      'MELHOR_ENVIO_TOKEN é obrigatório em produção para geração de etiquetas.',
    );
  }

  return new FakeShippingLabelService();
}

const shippingLabelServiceProvider: Provider = {
  provide: SHIPPING_LABEL_SERVICE,
  inject: [ConfigService],
  useFactory: resolveShippingLabelService,
};

const shippingProvider: Provider = {
  provide: SHIPPING_PROVIDER,
  inject: [ConfigService],
  useFactory: resolveShippingProvider,
};

const defaultWeightGrams: Provider = {
  provide: SHIPPING_DEFAULT_WEIGHT_GRAMS,
  inject: [ConfigService],
  useFactory: resolveDefaultWeightGrams,
};

/**
 * Owns freight pricing and label purchasing (docs/architecture/modules.md): the
 * ShippingProvider and ShippingLabelProvider tokens with adapters behind them.
 *
 * In production, resolves to HybridShippingProvider (Melhor Envio primary +
 * table fallback) and ShippingLabelService. In development without MELHOR_ENVIO_TOKEN,
 * uses the table and fake label service.
 */
@Module({
  providers: [
    shippingProvider,
    defaultWeightGrams,
    shippingLabelServiceProvider,
    CepService,
  ],
  exports: [
    SHIPPING_PROVIDER,
    SHIPPING_DEFAULT_WEIGHT_GRAMS,
    SHIPPING_LABEL_SERVICE,
    CepService,
  ],
})
export class ShippingModule {}
