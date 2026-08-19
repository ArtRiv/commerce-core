import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PERMISSIONS } from '../auth/authz/permissions';
import { ProductsService } from '../catalog/products.service';
import { StockService } from '../catalog/stock.service';
import type { Prisma } from '../generated/prisma/client';
import { OrderStatus, ProductStatus } from '../generated/prisma/enums';
import {
  type CheckoutMode,
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type PaymentSession,
} from '../payments/payment-provider';
import { PrismaService } from '../prisma/prisma.service';
import {
  itemsSubtotalCents,
  ShippingQuoteService,
} from './shipping-quote.service';

export interface ShippingAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
}

export interface OrderTracking {
  trackingCode?: string;
  trackingUrl?: string;
}

export interface CheckoutInput {
  address: ShippingAddress;
  /** The `code` of an option the customer was just quoted. */
  shippingOptionCode: string;
  /** What they were shown. Compared with a fresh quote, never charged. */
  quotedShippingCents: number;
  paymentMode?: CheckoutMode;
}

export interface ListOrdersInput {
  page?: number;
  perPage?: number;
  status?: OrderStatus;
  /** Callers without orders.read are refused this filter with a 403. */
  userId?: string;
}

/**
 * What the client needs to actually pay, returned by checkout and by /pay.
 *
 * Not a database row: clientSecret is deliberately never stored, so this shape
 * only ever exists in a response body (docs/specs/payments.md).
 */
export interface PaymentSessionView {
  mode: CheckoutMode;
  url: string | null;
  clientSecret: string | null;
  expiresAt: Date;
}

/** The little an order needs to expose for a payment session to be issued. */
interface PayableOrder {
  id: string;
  totalCents: number;
  paymentRef: string | null;
}

const MAX_PER_PAGE = 100;

/** Line items travel with every order read — they ARE the financial record. */
const ITEMS_INCLUDE = {
  items: {
    select: {
      productId: true,
      productName: true,
      unitPriceCents: true,
      quantity: true,
    },
    orderBy: { id: 'asc' },
  },
} as const;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toView(session: PaymentSession): PaymentSessionView {
  return {
    mode: session.mode,
    url: session.url,
    clientSecret: session.clientSecret,
    expiresAt: session.expiresAt,
  };
}

/**
 * The immutable half of the purchase flow, and the module's orchestrator:
 * checkout freezes the cart into an order (catalog prices → snapshots, stock
 * decremented atomically), and the state machine only ever moves through its
 * own methods — each transition a conditional UPDATE, so races are settled
 * by the database. See docs/specs/orders.md and docs/specs/payments.md.
 *
 * Ownership is query scoping, not a guard: callers without orders.read /
 * orders.cancel simply cannot SELECT foreign orders, so "someone else's id"
 * and "no such id" are the same 404 and existence never leaks.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly stock: StockService,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
    private readonly shipping: ShippingQuoteService,
  ) {}

  async checkout(userId: string, input: CheckoutInput) {
    const { address } = input;

    const cart = await this.prisma.cart.findUnique({
      where: { userId },
      include: { items: { orderBy: { id: 'asc' } } },
    });

    if (!cart || cart.items.length === 0) {
      throw new ConflictException('Cart is empty');
    }

    const products = await this.products.findByIds(
      cart.items.map((item) => item.productId),
    );
    const byId = new Map(products.map((product) => [product.id, product]));

    // Pre-check for a precise error; the decrement below re-checks status
    // atomically, so this is UX, not the integrity mechanism.
    const notSellable = cart.items
      .map((item) => item.productId)
      .filter((id) => byId.get(id)?.status !== ProductStatus.ACTIVE);
    if (notSellable.length > 0) {
      throw new ConflictException({
        message: 'Some cart items are no longer for sale',
        productIds: notSellable,
      });
    }

    const lines = cart.items.map((item) => {
      const product = byId.get(item.productId);

      return {
        productId: item.productId,
        quantity: item.quantity,
        unitPriceCents: product?.priceCents ?? 0,
        weightGrams: product?.weightGrams ?? null,
      };
    });

    const subtotalCents = itemsSubtotalCents(lines);

    // Freight is priced BEFORE anything is committed, and unlike the payment
    // call further down, a failure here aborts the checkout (503). The
    // asymmetry is deliberate: an order without a payment session is
    // recoverable — POST /orders/:id/pay exists for exactly that — but an
    // order without freight is an order with the wrong total, born immutable
    // and about to be charged. There is no route that repairs that, so the
    // only safe moment to fail is before the order exists.
    const options = await this.shipping.quote(address.postalCode, lines);
    const shipping = this.shipping.select(
      options,
      input.shippingOptionCode,
      input.quotedShippingCents,
    );

    const created = await this.prisma.$transaction(async (tx) => {
      // Consume the cart first, and count: a concurrent checkout of the same
      // cart blocks on these row locks, then deletes 0 rows and aborts here.
      // That check is what makes double-submit produce exactly one order.
      const { count } = await tx.cartItem.deleteMany({
        where: { cartId: cart.id },
      });
      if (count !== cart.items.length) {
        throw new ConflictException('Cart is empty');
      }

      const failed: string[] = [];
      for (const item of cart.items) {
        const ok = await this.stock.decrement(
          item.productId,
          item.quantity,
          tx,
        );
        if (!ok) {
          failed.push(item.productId);
        }
      }
      // Throwing rolls the whole transaction back — cart intact, stock
      // untouched, no order. All losing items are named, not just the first.
      if (failed.length > 0) {
        throw new ConflictException({
          message: 'Insufficient stock or product no longer for sale',
          productIds: failed,
        });
      }

      return tx.order.create({
        data: {
          userId,
          itemsSubtotalCents: subtotalCents,
          shippingCents: shipping.priceCents,
          // The amount charged. A CHECK constraint holds this identity in the
          // database too, so no future write can put the three out of step.
          totalCents: subtotalCents + shipping.priceCents,
          shippingLine1: address.line1,
          shippingLine2: address.line2 ?? null,
          shippingCity: address.city,
          shippingState: address.state,
          shippingPostalCode: address.postalCode,
          // Frozen like the price: a bare number is not auditable, and the
          // confirmation email needs the promise that came with it.
          shippingMethodCode: shipping.code,
          shippingMethodName: shipping.label,
          shippingEtaDays: shipping.estimatedDays,
          items: {
            create: cart.items.map((item) => {
              const product = byId.get(item.productId);
              return {
                productId: item.productId,
                // The snapshot: what was bought at the price paid, frozen
                // beyond the reach of future catalog edits.
                productName: product?.name ?? '',
                unitPriceCents: product?.priceCents ?? 0,
                quantity: item.quantity,
              };
            }),
          },
        },
        include: ITEMS_INCLUDE,
      });
    });

    // Outside the transaction on purpose: an external call must not hold DB
    // locks. And a failure here does NOT undo the checkout — the order exists,
    // the stock is committed, and only the way to pay is missing. Same stance
    // as AuthService.register when the verification email cannot be sent: the
    // account is real, and there is a route to ask for another one. Here that
    // route is POST /orders/:id/pay.
    let payment: PaymentSessionView | null = null;
    try {
      payment = await this.issueSession(created, input.paymentMode);
    } catch (error: unknown) {
      this.logger.error(
        `Order ${created.id} was created but the payment provider failed: ${describe(error)}`,
      );
    }

    const order = payment ? await this.getById(created.id) : created;

    return { ...order, payment };
  }

  /**
   * Issues (or hands back) the way to pay a CREATED order.
   *
   * This is the recovery path for every way a session can go missing: the
   * provider was down at checkout, the buyer closed the tab, the session
   * expired. It is also where the double-charge risk is managed — an order
   * with an open session gets that same session back rather than a second one.
   */
  async pay(user: AuthenticatedUser, id: string, mode?: CheckoutMode) {
    const canReadAll = user.permissions.has(PERMISSIONS.ORDERS_READ);
    const canPayAny = user.permissions.has(PERMISSIONS.ORDERS_UPDATE_STATUS);

    // Same visibility-then-capability split as cancel: invisible is a 404,
    // visible-but-not-yours is an honest 403.
    const order = await this.prisma.order.findFirst({
      where: { id, ...(canReadAll || canPayAny ? {} : { userId: user.id }) },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.userId !== user.id && !canPayAny) {
      throw new ForbiddenException(
        "Paying someone else's order requires the orders.update_status permission",
      );
    }

    if (order.status !== OrderStatus.CREATED) {
      throw new ConflictException(
        `Order is ${order.status}; only a CREATED order can be paid`,
      );
    }

    let payment: PaymentSessionView;
    try {
      payment = await this.issueSession(order, mode);
    } catch (error: unknown) {
      // A refusal from issueSession is a deliberate answer about this order's
      // state — already paid at the provider, or no longer awaiting payment —
      // and has to reach the caller intact. Repainting it as a 503 would invite
      // exactly the retry it exists to prevent.
      if (error instanceof ConflictException) {
        throw error;
      }

      // Anything else is the provider being unreachable. Unlike checkout, there
      // is nothing else this request was for — failing loudly beats answering
      // 200 with no way to pay.
      this.logger.error(
        `Could not issue a payment session for order ${id}: ${describe(error)}`,
      );
      throw new ServiceUnavailableException(
        'The payment provider is unavailable right now; please try again',
      );
    }

    return { ...(await this.getById(id)), payment };
  }

  async list(user: AuthenticatedUser, query: ListOrdersInput) {
    const canReadAll = user.permissions.has(PERMISSIONS.ORDERS_READ);

    if (query.userId && !canReadAll) {
      // 403 rather than silently ignoring the filter: the caller asked a
      // privileged question and should learn it was denied (same stance as
      // the catalog's status filter).
      throw new ForbiddenException(
        'Filtering by user requires the orders.read permission',
      );
    }

    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const perPage = Math.min(
      MAX_PER_PAGE,
      Math.max(1, Math.trunc(query.perPage ?? 20)),
    );

    const where: Prisma.OrderWhereInput = {
      ...(canReadAll
        ? query.userId
          ? { userId: query.userId }
          : {}
        : { userId: user.id }),
      ...(query.status ? { status: query.status } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        include: ITEMS_INCLUDE,
      }),
      this.prisma.order.count({ where }),
    ]);

    return { items, total, page, perPage };
  }

  async findOne(user: AuthenticatedUser, id: string) {
    const canReadAll = user.permissions.has(PERMISSIONS.ORDERS_READ);

    const order = await this.prisma.order.findFirst({
      where: { id, ...(canReadAll ? {} : { userId: user.id }) },
      include: ITEMS_INCLUDE,
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    return order;
  }

  async cancel(user: AuthenticatedUser, id: string) {
    const canReadAll = user.permissions.has(PERMISSIONS.ORDERS_READ);
    const canCancelAny = user.permissions.has(PERMISSIONS.ORDERS_CANCEL);

    // Visibility first, capability second: whoever cannot SEE the order gets
    // the same 404 as a missing id (nothing to confirm), while someone who
    // can see it but may not cancel it — an operator with orders.read —
    // gets an honest 403. Collapsing both into one filter would 404 people
    // the GET route happily answers.
    const order = await this.prisma.order.findFirst({
      where: {
        id,
        ...(canReadAll || canCancelAny ? {} : { userId: user.id }),
      },
      include: { items: { select: { productId: true, quantity: true } } },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.userId !== user.id && !canCancelAny) {
      throw new ForbiddenException(
        "Cancelling someone else's order requires the orders.cancel permission",
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // Conditional on CREATED so a cancel racing a mark-paid cannot revoke
      // a paid order — whichever UPDATE matches first wins, the loser sees 0
      // rows here regardless of what it read a moment ago.
      const { count } = await tx.order.updateMany({
        where: { id, status: OrderStatus.CREATED },
        data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() },
      });

      if (count === 0) {
        throw new ConflictException(
          'Only CREATED orders can be cancelled — a paid order is refunded instead',
        );
      }

      for (const item of order.items) {
        await this.stock.restock(item.productId, item.quantity, tx);
      }
    });

    // The stock just went back on the shelf and may be sold to someone else,
    // so the old way to pay this order must stop working. Best-effort and
    // after the fact on purpose: cancelling is the customer's action and
    // cannot be held hostage to the provider being reachable.
    if (order.paymentRef) {
      await this.expireQuietly(order.paymentRef);
    }

    return this.getById(id);
  }

  /**
   * Gives the money back and returns the goods to the shelf.
   *
   * Gated by orders.refund at the route, so there is no ownership logic here —
   * refunding is a back-office action, like ship and deliver.
   */
  async refund(id: string) {
    const order = await this.prisma.order.findUnique({ where: { id } });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.status !== OrderStatus.PAID) {
      throw new ConflictException(
        `Order is ${order.status}; only a PAID order can be refunded`,
      );
    }

    if (!order.paymentIntentRef) {
      // An order marked paid by hand (bank transfer, Pix outside the gateway)
      // has no provider payment to reverse. Pretending otherwise would ask
      // Stripe to return money it never took.
      throw new ConflictException(
        'This order has no provider payment to refund — it was recorded as paid manually, so the refund has to happen the same way',
      );
    }

    // Provider first, database second (external call outside the transaction,
    // same rule as checkout). If the UPDATE below fails after the money moved,
    // the charge.refunded webhook converges the order to REFUNDED anyway.
    const { refundRef } = await this.payments.refund({
      paymentIntentRef: order.paymentIntentRef,
    });

    const applied = await this.applyRefund(id, refundRef);

    if (!applied) {
      // Something else refunded this order between the read and the write.
      // The money we just sent back is real, so this is an error, not a
      // routine conflict.
      this.logger.error(
        `Refund ${refundRef} went through at the provider but order ${id} was no longer PAID — likely refunded twice, needs manual reconciliation`,
      );
      throw new ConflictException(
        'Order is no longer PAID; a refund was issued at the provider and needs manual reconciliation',
      );
    }

    return this.getById(id);
  }

  /**
   * The refund seam for the webhook, mirroring markPaid: a refund started in
   * the Stripe dashboard has to land in the same place as one started here.
   *
   * Returns whether it applied, rather than throwing, because "already
   * refunded" is a normal thing for a redelivered event to find.
   */
  markRefunded(id: string, refundRef: string | null): Promise<boolean> {
    return this.applyRefund(id, refundRef);
  }

  /**
   * The payment seam (docs/specs/orders.md): an operator route calls this to
   * record a manual payment, and the Stripe webhook calls the same method.
   * Orders' lifecycle does not change when the real provider arrives.
   */
  markPaid(id: string, paymentIntentRef?: string) {
    return this.transition(
      id,
      OrderStatus.CREATED,
      OrderStatus.PAID,
      'paidAt',
      paymentIntentRef ? { paymentIntentRef } : {},
    );
  }

  /**
   * PAID → SHIPPED, optionally stamping tracking details.
   *
   * Tracking is data hung on an existing transition, not a new state: a
   * shipment with no code — a courier, a local hand-off — is still a
   * shipment, so an absent code leaves the columns null rather than blocking.
   */
  ship(id: string, tracking: OrderTracking = {}) {
    return this.transition(
      id,
      OrderStatus.PAID,
      OrderStatus.SHIPPED,
      'shippedAt',
      {
        ...(tracking.trackingCode
          ? { trackingCode: tracking.trackingCode }
          : {}),
        ...(tracking.trackingUrl ? { trackingUrl: tracking.trackingUrl } : {}),
      },
    );
  }

  deliver(id: string) {
    return this.transition(
      id,
      OrderStatus.SHIPPED,
      OrderStatus.DELIVERED,
      'deliveredAt',
    );
  }

  /**
   * Hands back the order's open session, or issues a new one.
   *
   * Reuse is the whole point: two open sessions for one order are two ways to
   * charge the same buyer. Everything below exists to keep that from happening,
   * because each escape route ends in someone being charged twice:
   *
   * - a COMPLETED session refuses rather than replacing — the buyer already
   *   went through checkout and only the confirmation is late;
   * - a mode switch expires the old session and lets a failure to do so
   *   ABORT, since proceeding is exactly what would leave two of them payable;
   * - the final write is conditional on the order still being CREATED, so a
   *   session cannot be stapled to an order that was cancelled while the
   *   provider call was in flight.
   */
  private async issueSession(
    order: PayableOrder,
    mode?: CheckoutMode,
  ): Promise<PaymentSessionView> {
    if (order.paymentRef) {
      const existing = await this.payments.getPayment(order.paymentRef);

      if (existing.state === 'completed') {
        // The order is still CREATED only because the webhook has not landed.
        // Issuing another session here is the double-charge this whole method
        // is written to prevent.
        throw new ConflictException(
          'This order has already been paid at the provider; waiting for confirmation',
        );
      }

      if (existing.state === 'open') {
        if (mode === undefined || existing.session.mode === mode) {
          return toView(existing.session);
        }

        // Deliberately NOT best-effort: if the old session survives, the
        // replacement below becomes a second way to pay the same order.
        await this.payments.expirePayment(order.paymentRef);
      }
    }

    const session = await this.payments.createPayment({
      orderId: order.id,
      amountCents: order.totalCents,
      mode,
    });

    const { count } = await this.prisma.order.updateMany({
      where: { id: order.id, status: OrderStatus.CREATED },
      data: {
        paymentRef: session.providerRef,
        paymentUrl: session.url,
        paymentExpiresAt: session.expiresAt,
      },
    });

    if (count === 0) {
      // The order moved while we were at the provider — cancelled, or paid by
      // another route. The session we just made is unreferenced and payable,
      // so close it rather than leaving it open against a settled order.
      await this.expireQuietly(session.providerRef);

      throw new ConflictException(
        'Order is no longer awaiting payment; no session was issued',
      );
    }

    return toView(session);
  }

  private async expireQuietly(providerRef: string): Promise<void> {
    try {
      await this.payments.expirePayment(providerRef);
    } catch (error: unknown) {
      this.logger.warn(
        `Could not expire payment session ${providerRef}: ${describe(error)}`,
      );
    }
  }

  /**
   * PAID → REFUNDED plus restocking, in one transaction, for both the API and
   * the webhook. Conditional on PAID, so a refund arriving twice — the route
   * and then the provider's own event — only ever restocks once.
   */
  private applyRefund(id: string, refundRef: string | null): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id, status: OrderStatus.PAID },
        data: {
          status: OrderStatus.REFUNDED,
          refundedAt: new Date(),
          ...(refundRef ? { refundRef } : {}),
        },
      });

      if (count === 0) {
        return false;
      }

      // Only a PAID order is refundable, and a PAID order has not shipped, so
      // the units are still ours to put back — same call the cancellation path
      // uses.
      const items = await tx.orderItem.findMany({
        where: { orderId: id },
        select: { productId: true, quantity: true },
      });

      for (const item of items) {
        await this.stock.restock(item.productId, item.quantity, tx);
      }

      return true;
    });
  }

  /**
   * Every lifecycle move is one conditional UPDATE: match id+expected status,
   * set the new status and its timestamp. Zero rows means either no such
   * order (404) or the wrong state (409, naming the current one) — decided
   * by a follow-up read that never races anything, because the answer only
   * shapes the error message.
   */
  private async transition(
    id: string,
    from: OrderStatus,
    to: OrderStatus,
    stamp: 'paidAt' | 'shippedAt' | 'deliveredAt',
    extra: Prisma.OrderUpdateManyMutationInput = {},
  ) {
    const { count } = await this.prisma.order.updateMany({
      where: { id, status: from },
      data: { status: to, [stamp]: new Date(), ...extra },
    });

    if (count === 0) {
      const existing = await this.prisma.order.findUnique({
        where: { id },
        select: { status: true },
      });

      if (!existing) {
        throw new NotFoundException('Order not found');
      }

      throw new ConflictException(
        `Order is ${existing.status}; only a ${from} order can move to ${to}`,
      );
    }

    return this.getById(id);
  }

  private async getById(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: ITEMS_INCLUDE,
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    return order;
  }
}
