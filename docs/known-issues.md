# Known issues

Bugs and gaps found after a module shipped — accepted for now, not
forgotten. Not a backlog of features; that lives in each spec's
"decisões adiadas". This is specifically for things that are, in some
small way, wrong.

Format: one entry per issue — where, what, why it's accepted, what
fixing it looks like.

## orders: cart item quantity has no cumulative cap

**Where**: `CartService.addItem` (`src/orders/cart.service.ts`).

**What**: `AddCartItemDto.quantity` is capped at 999 per request, and
`CartService` re-validates that same per-call value — but adds are
cumulative (`increment`). Two sequential `POST /cart/items` calls of
600 each produce a cart line of 1200, past the documented per-item
cap. There's also no DB `CHECK` upper bound on `cart_items.quantity`
(only `> 0`), so nothing catches it at any layer.

**Why accepted for v1**: low severity. It can't corrupt data or break
an invariant — checkout's real stock check (`StockService.decrement`)
still governs what can actually be bought, so an oversized cart line
just fails at checkout with the normal insufficient-stock `409`. The
999 cap was a sanity bound on a single request, not a promise about
the cart's total.

**Fix sketch**: `CartService.addItem` reads the existing line's
quantity before upserting and validates `existing + quantity <= 999`
in the same query (or checks post-write and reverts), or drop the
cumulative cap entirely and only bound absolute `setQuantity`. Small
either way — revisit if it ever matters (found during code review,
2026-07-21).
