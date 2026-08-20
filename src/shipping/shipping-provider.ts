/**
 * Pricing delivery, behind a token — the same seam as PaymentProvider and
 * MailService: orders depends on this interface, never on a carrier, so
 * replacing the table with Correios or Melhor Envio is a shipping-module
 * change and nothing else (docs/architecture/modules.md,
 * docs/specs/shipping.md).
 *
 * The shape is deliberately the CARRIER's shape rather than the table's, even
 * though the table is what ships in v1. A quote is asynchronous, returns many
 * options, may legitimately refuse a destination, and may fail outright —
 * none of which the table provider needs and all of which a real carrier does.
 * An interface fitted to the easy implementation would have to be rewritten by
 * the first hard one, and rewriting it means touching orders, which is the
 * whole thing this token exists to prevent.
 */

export interface ShippingQuoteItem {
  productId: string;
  quantity: number;
  /** Declared value, and what free-shipping thresholds are measured against. */
  unitPriceCents: number;
  /**
   * Already resolved: the configured default has been applied for products
   * with no weight of their own, so nothing downstream deals in nulls.
   */
  weightGrams: number;
}

export interface ShippingQuoteRequest {
  /**
   * The postal code alone. In Brazil the CEP determines city and state, and
   * it is what Correios and Melhor Envio actually quote against — city and
   * state stay in the order's address snapshot without feeding the price.
   */
  destination: { postalCode: string };
  items: ShippingQuoteItem[];
  subtotalCents: number;
}

export interface ShippingOption {
  /** Stable identity: 'padrao-sudeste' today, 'correios.pac' later. */
  code: string;
  label: string;
  /** Zero is free shipping — a real option at no cost, not a missing one. */
  priceCents: number;
  estimatedDays: number | null;
  carrier: string | null;
}

export interface ShippingProvider {
  /**
   * An empty array means "we do not deliver there" — a legitimate answer, not
   * an error, and the caller turns it into a 409 at checkout. THROWING means
   * the carrier itself is unreachable, which becomes a 503.
   *
   * Those two have to stay distinguishable: one is a fact about the address
   * that retrying will never change, the other is a temporary outage.
   */
  quote(request: ShippingQuoteRequest): Promise<ShippingOption[]>;
}

export const SHIPPING_PROVIDER = Symbol('SHIPPING_PROVIDER');

/**
 * What a product with no weight of its own is assumed to weigh.
 *
 * Exported as a token rather than read from config by orders, so every
 * SHIPPING_* variable stays owned by this module — and kept off the provider
 * interface, because a real carrier has no opinion about our missing data.
 */
export const SHIPPING_DEFAULT_WEIGHT_GRAMS = Symbol(
  'SHIPPING_DEFAULT_WEIGHT_GRAMS',
);
