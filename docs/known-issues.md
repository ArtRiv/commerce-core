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

## orders: provider identifiers ship in every order response

**Where**: `OrdersService.getById` / `list` / `findOne`
(`src/orders/orders.service.ts`), which return the Prisma `Order` row
whole.

**What**: `paymentRef` (`cs_…`), `paymentIntentRef` (`pi_…`) and
`refundRef` (`re_…`) are Stripe object identifiers, and every read of an
order hands them to the client. Nothing consumes them: a buyer pays
through `payment.url` / `payment.clientSecret`, and the back office has
the Stripe dashboard. They are internal plumbing sitting in the public
contract, and they are now visible as such in the published OpenAPI
document.

**Why accepted for v1**: not a credential — possession of a session or
intent id charges nobody without the secret key — and the recipient is
already the order's owner or an operator holding `orders.read`. The cost
is coupling, not disclosure: a client is free to build on a field we
would like to stop sending.

Removing them was scoped into the OpenAPI work and pulled back out.
`test/payments.e2e-spec.ts`, `test/orders.e2e-spec.ts` and
`test/order-emails.e2e-spec.ts` read those refs **off the HTTP response**
to drive the Stripe fake — mark a session paid, build a webhook event,
assert the refund — about 40 assertions across three files. That is a
behaviour change plus a test refactor inside a pull request whose whole
premise was documenting existing behaviour without altering it.

**Fix sketch**: a Prisma `select` in `ITEMS_INCLUDE`'s sibling query
listing the fields an order response actually needs, and the three e2e
suites reading the refs from the database (they already hold a
`PrismaService` for other assertions) instead of the response body. Small
and mechanical, but it belongs in its own PR — and it becomes free the
day the deferred `ClassSerializerInterceptor` from
[`specs/openapi.md`](specs/openapi.md) lands, since an unexposed field
stops being sent whether or not the query selects it (found during the
OpenAPI route audit, 2026-08-20).

## shipping: the freight table parser ignores keys it does not know

**Where**: `parseShippingTable` (`src/shipping/shipping-table.ts`).

**What**: validation checks the fields it knows about and says nothing
about the rest, so a misspelled key is not an error — it is a silently
absent value. `.env.example` and `docs/specs/shipping.md` both documented
the delivery estimate as `etaDays` while the parser has always read
`estimatedDays`, and the result was a table that loads, boots, prices
freight correctly and quotes **every option with no ETA at all**. The
order stores `shippingEtaDays: null` and the confirmation e-mail has no
estimate to show.

The documented example was wrong for as long as it existed and nothing
caught it: the boot guard passes, the unit tests use their own fixtures
(which spell it correctly), and a null ETA is a legal value for an option
that genuinely has none.

**Why accepted for v1**: the data is fixed — `.env.example`, the spec and
`render.yaml` now all say `estimatedDays`, verified through the parser
itself rather than by eye (found while wiring the deploy, 2026-08-21).
What is left is the parser's tolerance, and tightening it is a behaviour
change: a table that a running deployment accepts today would start
refusing to boot, which is not a thing to slip into a deploy PR.

**Fix sketch**: reject unknown keys per option and per rate, in the same
pass that already validates the known ones, naming the offending key and
option the way every other message in that file does. Suggesting the
nearest known key ("unknown option key \"etaDays\" — did you mean
\"estimatedDays\"?") is what turns it from a rule into a fix. Worth doing
next time that file is open, and worth a line in the spec's config
section either way.
