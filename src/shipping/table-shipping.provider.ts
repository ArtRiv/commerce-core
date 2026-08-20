import { Injectable } from '@nestjs/common';

import type {
  ShippingOption,
  ShippingProvider,
  ShippingQuoteRequest,
} from './shipping-provider';
import {
  normalizePostalCode,
  type ShippingTableOption,
} from './shipping-table';

/**
 * The freight table as a provider — and the real one for v1, not a stand-in.
 *
 * This is the deliberate difference from payments: there is no "fake" here and
 * no production guard on the provider itself, because a table has no third
 * party behind it. It is deterministic, needs no network and no contract, and
 * a CEP-zone table with a free-shipping threshold is what most small Brazilian
 * stores genuinely run. What can be wrong is the CONFIGURATION, and that is
 * checked at boot (see parseShippingTable), not here.
 *
 * Every rule it applies is in docs/specs/shipping.md; the two that matter most:
 * an unservable destination is an empty list rather than an error, and free
 * shipping is a price of zero rather than a missing option.
 */
@Injectable()
export class TableShippingProvider implements ShippingProvider {
  constructor(
    private readonly table: readonly ShippingTableOption[],
    /** Null disables free shipping entirely, which is not the same as 0. */
    private readonly freeAboveCents: number | null,
  ) {}

  quote(request: ShippingQuoteRequest): Promise<ShippingOption[]> {
    const postalCode = normalizePostalCode(request.destination.postalCode);

    // Defence in depth rather than the real gate: the DTOs reject a malformed
    // CEP with a 400 long before this. Reaching here with one means we cannot
    // say where the parcel goes, and "no options" is the honest answer.
    if (!postalCode) {
      return Promise.resolve([]);
    }

    const totalGrams = request.items.reduce(
      (grams, item) => grams + item.weightGrams * item.quantity,
      0,
    );

    // Measured against the ITEMS' subtotal, never the total: a threshold that
    // counted freight toward itself would be circular.
    const isFree =
      this.freeAboveCents !== null &&
      request.subtotalCents >= this.freeAboveCents;

    const options: ShippingOption[] = [];

    for (const option of this.table) {
      if (!option.prefixes.some((prefix) => postalCode.startsWith(prefix))) {
        continue;
      }

      // First bracket that covers the parcel. Nothing covering it means this
      // option has a ceiling below the parcel's weight — it drops out rather
      // than falling back to the heaviest bracket, which would be a price we
      // never agreed to carry.
      const rate = option.rates.find(
        (bracket) => totalGrams <= bracket.upToGrams,
      );

      if (!rate) {
        continue;
      }

      options.push({
        code: option.code,
        label: option.label,
        priceCents: isFree ? 0 : rate.priceCents,
        estimatedDays: option.estimatedDays,
        carrier: option.carrier,
      });
    }

    return Promise.resolve(options.sort(compareOptions));
  }
}

/**
 * Cheapest first, then fastest, then by code.
 *
 * The last tiebreak is arbitrary but it is what makes the order TOTAL: without
 * it, two options at the same price and speed could swap places between calls,
 * and a storefront that preselects "the first one" would appear to change its
 * mind on its own.
 */
function compareOptions(left: ShippingOption, right: ShippingOption): number {
  if (left.priceCents !== right.priceCents) {
    return left.priceCents - right.priceCents;
  }

  // A missing estimate sorts last: an option that will not say how long it
  // takes should not outrank one that does.
  const leftDays = left.estimatedDays ?? Number.MAX_SAFE_INTEGER;
  const rightDays = right.estimatedDays ?? Number.MAX_SAFE_INTEGER;

  if (leftDays !== rightDays) {
    return leftDays - rightDays;
  }

  return left.code.localeCompare(right.code);
}
