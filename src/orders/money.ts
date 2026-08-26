/**
 * The arithmetic of a cart, in one place.
 *
 * These two functions are the only definition of "how much is in there" that
 * this API has. The cart response, the freight quote and the checkout that
 * freezes `itemsSubtotalCents` onto an order all call them, so the number a
 * storefront renders and the number the customer is charged cannot drift —
 * two subtly different sums would put the free-shipping threshold, the
 * displayed total and the stored subtotal out of step. See
 * docs/specs/cart-totals.md.
 *
 * Plain functions in a module with no class and no injection, deliberately.
 * `CartService` needs the subtotal and `ShippingQuoteService` already depends
 * on `CartService`; anything with a constructor here would close a runtime
 * import cycle, because `design:paramtypes` emits a value reference, not just
 * a type.
 */

/** Sum of unit price × quantity. Zero for an empty list, never null. */
export function itemsSubtotalCents(
  items: readonly { unitPriceCents: number; quantity: number }[],
): number {
  return items.reduce(
    (sum, item) => sum + item.unitPriceCents * item.quantity,
    0,
  );
}

/**
 * Sum of quantities — pieces, not lines. Two shirts and a pair of trousers
 * is 3, which is what a cart badge shows; counting lines would say 2.
 */
export function itemCount(items: readonly { quantity: number }[]): number {
  return items.reduce((count, item) => count + item.quantity, 0);
}
