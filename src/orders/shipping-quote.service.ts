import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import {
  SHIPPING_DEFAULT_WEIGHT_GRAMS,
  SHIPPING_PROVIDER,
  type ShippingOption,
  type ShippingProvider,
} from '../shipping/shipping-provider';
import { CartService } from './cart.service';
import { itemsSubtotalCents } from './money';

/** A line to be priced: catalog data already read, weight not yet resolved. */
export interface QuotableItem {
  productId: string;
  quantity: number;
  unitPriceCents: number;
  /** Null for a product nobody has weighed; the configured default fills in. */
  weightGrams: number | null;
}

/**
 * A quoted option with the number a checkout screen actually renders.
 *
 * `orderTotalCents` is the subtotal plus this option's freight — what
 * POST /orders will charge if the customer picks it. Computing it here rather
 * than in the browser is the point: it is the same arithmetic checkout does,
 * so a drift between the two is a bug with a test on it, not a rounding
 * difference nobody notices (docs/specs/cart-totals.md).
 */
export interface QuotedOption extends ShippingOption {
  orderTotalCents: number;
}

/** What the quote endpoint answers: the priced cart and its options. */
export interface CartQuote {
  options: QuotedOption[];
  /** The same number GET /cart reports, measured over the same cart. */
  itemsSubtotalCents: number;
}

/**
 * Freight pricing for the cart and for checkout, in one place.
 *
 * It lives in `orders`, not in `shipping`, for the same reason the payment
 * webhook controller does: pricing a quote means reading a CART. Putting it
 * the other side of the token would make `shipping` depend on `orders` (or on
 * `catalog`, for weights), which is a cycle and the reverse of the module
 * map's one rule. What crosses the boundary is a request that is already
 * complete. See docs/specs/shipping.md.
 */
@Injectable()
export class ShippingQuoteService {
  private readonly logger = new Logger(ShippingQuoteService.name);

  constructor(
    private readonly carts: CartService,
    @Inject(SHIPPING_PROVIDER) private readonly provider: ShippingProvider,
    @Inject(SHIPPING_DEFAULT_WEIGHT_GRAMS)
    private readonly defaultWeightGrams: number,
  ) {}

  /**
   * The quote endpoint: the caller's own cart, priced to a postal code.
   *
   * Answers with the cart's item subtotal beside the options, and stamps each
   * option with the order total it implies. The route already had to read the
   * cart to weigh it, so it already knew both numbers — leaving them out only
   * ever meant a storefront adding money in JavaScript.
   */
  async quoteForCart(userId: string, postalCode: string): Promise<CartQuote> {
    const cart = await this.carts.getCart(userId);

    if (cart.items.length === 0) {
      // Nothing to weigh and nothing to ship. Same 409 checkout gives an
      // empty cart, rather than a meaningless empty options list.
      throw new ConflictException('Cart is empty');
    }

    const options = await this.quote(
      postalCode,
      cart.items.map((item) => ({
        // Freight speaks in PRODUCTS: weight is a property of the article, not
        // of its size, so two lines of one shirt in P and M are two lines of
        // the same product id here.
        productId: item.product.id,
        quantity: item.quantity,
        unitPriceCents: item.product.priceCents,
        weightGrams: item.product.weightGrams,
      })),
    );

    // The cart's own subtotal, not a second sum computed here: one definition
    // (money.ts), measured once, reported by both routes.
    const { itemsSubtotalCents: subtotalCents } = cart;

    return {
      itemsSubtotalCents: subtotalCents,
      options: options.map((option) => ({
        ...option,
        // Free shipping is a price of zero, so this is simply the subtotal —
        // an option at no cost, not a missing number.
        orderTotalCents: subtotalCents + option.priceCents,
      })),
    };
  }

  /**
   * Prices already-loaded lines, resolving missing weights on the way out so
   * the provider never deals in nulls.
   *
   * A provider failure becomes a 503 here, once, for both callers — the
   * distinction the interface draws between "no options" (nothing can carry
   * this, to there: a fact retrying will not change) and "it threw" (the
   * carrier is down, try later) is only worth drawing if it survives to the
   * response.
   */
  async quote(
    postalCode: string,
    items: readonly QuotableItem[],
  ): Promise<ShippingOption[]> {
    try {
      return await this.provider.quote({
        destination: { postalCode },
        subtotalCents: itemsSubtotalCents(items),
        items: items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          weightGrams: item.weightGrams ?? this.defaultWeightGrams,
        })),
      });
    } catch (error: unknown) {
      this.logger.error(
        `Could not quote shipping to ${postalCode}: ${error instanceof Error ? error.message : String(error)}`,
      );

      throw new ServiceUnavailableException(
        'Shipping cannot be quoted right now; please try again',
      );
    }
  }

  /**
   * Resolves the customer's choice against a fresh quote, and refuses to
   * proceed on any disagreement.
   *
   * This is where the money rule is enforced: the client picked a CODE and
   * asserted a PRICE, and only the server's own recomputation is ever
   * charged. Every refusal hands back the current options, because the only
   * useful thing a storefront can do with this error is show them.
   */
  select(
    options: readonly ShippingOption[],
    code: string,
    quotedShippingCents: number,
  ): ShippingOption {
    if (options.length === 0) {
      // Two different causes land here — nothing serves that postal code, or
      // nothing can carry a parcel this heavy — and the provider does not
      // distinguish them, so the message must be true of both. Naming only
      // the postal code would misdescribe an overweight cart.
      throw new ConflictException({
        message: 'No delivery option is available for this cart and address',
        shippingOptions: [],
      });
    }

    const chosen = options.find((option) => option.code === code);

    if (!chosen) {
      throw new ConflictException({
        message:
          'That shipping option is not available for this address; please quote again',
        shippingOptions: options,
      });
    }

    if (chosen.priceCents !== quotedShippingCents) {
      // Charging the new price silently would never undercharge us, but it
      // would charge the customer something they were never shown — and the
      // CDC (art. 30) binds a supplier to the offer it advertised.
      throw new ConflictException({
        message:
          'The shipping price changed since it was quoted; please quote again',
        shippingOptions: options,
      });
    }

    return chosen;
  }
}
