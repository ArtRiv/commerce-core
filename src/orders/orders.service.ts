import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PERMISSIONS } from '../auth/authz/permissions';
import { ProductsService } from '../catalog/products.service';
import { StockService } from '../catalog/stock.service';
import type { Prisma } from '../generated/prisma/client';
import { OrderStatus, ProductStatus } from '../generated/prisma/enums';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '../payments/payment-provider';
import { PrismaService } from '../prisma/prisma.service';

export interface ShippingAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
}

export interface ListOrdersInput {
  page?: number;
  perPage?: number;
  status?: OrderStatus;
  /** Callers without orders.read are refused this filter with a 403. */
  userId?: string;
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

/**
 * The immutable half of the purchase flow, and the module's orchestrator:
 * checkout freezes the cart into an order (catalog prices → snapshots, stock
 * decremented atomically), and the state machine only ever moves through its
 * own methods — each transition a conditional UPDATE, so races are settled
 * by the database. See docs/specs/orders.md.
 *
 * Ownership is query scoping, not a guard: callers without orders.read /
 * orders.cancel simply cannot SELECT foreign orders, so "someone else's id"
 * and "no such id" are the same 404 and existence never leaks.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly stock: StockService,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
  ) {}

  async checkout(userId: string, address: ShippingAddress) {
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

    const totalCents = cart.items.reduce(
      (sum, item) =>
        sum + (byId.get(item.productId)?.priceCents ?? 0) * item.quantity,
      0,
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
          totalCents,
          shippingLine1: address.line1,
          shippingLine2: address.line2 ?? null,
          shippingCity: address.city,
          shippingState: address.state,
          shippingPostalCode: address.postalCode,
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
    // locks. The fake provider cannot fail; real-provider failure handling
    // (retry, reconciliation) arrives with the payments module.
    const { providerRef } = await this.payments.createPayment({
      orderId: created.id,
      amountCents: created.totalCents,
    });

    return this.prisma.order.update({
      where: { id: created.id },
      data: { paymentRef: providerRef },
      include: ITEMS_INCLUDE,
    });
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
    const canCancelAny = user.permissions.has(PERMISSIONS.ORDERS_CANCEL);

    const order = await this.prisma.order.findFirst({
      where: { id, ...(canCancelAny ? {} : { userId: user.id }) },
      include: { items: { select: { productId: true, quantity: true } } },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
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
          'Only CREATED orders can be cancelled — refunds do not exist yet',
        );
      }

      for (const item of order.items) {
        await this.stock.restock(item.productId, item.quantity, tx);
      }
    });

    return this.getById(id);
  }

  /**
   * The payment seam (docs/specs/orders.md): today an operator route calls
   * this; when Stripe lands its webhook calls the same method. Orders'
   * lifecycle does not change when the real provider arrives.
   */
  markPaid(id: string) {
    return this.transition(id, OrderStatus.CREATED, OrderStatus.PAID, 'paidAt');
  }

  ship(id: string) {
    return this.transition(
      id,
      OrderStatus.PAID,
      OrderStatus.SHIPPED,
      'shippedAt',
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
  ) {
    const { count } = await this.prisma.order.updateMany({
      where: { id, status: from },
      data: { status: to, [stamp]: new Date() },
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
