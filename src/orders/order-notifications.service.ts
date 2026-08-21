import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  MAIL_SERVICE,
  type MailService,
  type OrderEmailData,
} from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Everything an order email says, read in one query.
 *
 * Deliberately its own SELECT rather than a wider ITEMS_INCLUDE on
 * OrdersService: joining the user there would put the customer's email address
 * into the body of every GET /orders response, including an operator's listing
 * of everyone's orders. See docs/specs/order-emails.md.
 */
const EMAIL_SELECT = {
  id: true,
  itemsSubtotalCents: true,
  shippingCents: true,
  totalCents: true,
  shippingMethodName: true,
  shippingEtaDays: true,
  shippingLine1: true,
  shippingLine2: true,
  shippingCity: true,
  shippingState: true,
  shippingPostalCode: true,
  trackingCode: true,
  trackingUrl: true,
  user: { select: { email: true, name: true } },
  items: {
    select: { productName: true, unitPriceCents: true, quantity: true },
    orderBy: { id: 'asc' },
  },
} as const;

type NotifiableOrder = {
  id: string;
  itemsSubtotalCents: number;
  shippingCents: number;
  totalCents: number;
  shippingMethodName: string | null;
  shippingEtaDays: number | null;
  shippingLine1: string;
  shippingLine2: string | null;
  shippingCity: string;
  shippingState: string;
  shippingPostalCode: string;
  trackingCode: string | null;
  trackingUrl: string | null;
  user: { email: string; name: string | null };
  items: {
    productName: string;
    unitPriceCents: number;
    quantity: number;
  }[];
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toEmailData(order: NotifiableOrder): OrderEmailData {
  return {
    orderId: order.id,
    customerName: order.user.name,
    items: order.items,
    itemsSubtotalCents: order.itemsSubtotalCents,
    // The method name and code are written together at checkout, so a null
    // name means an order created before freight existed — where the zero in
    // shippingCents is a backfill, not a price. Reporting { cents: 0 } there
    // would promise free shipping that was never offered.
    freight:
      order.shippingMethodName === null
        ? null
        : {
            cents: order.shippingCents,
            methodName: order.shippingMethodName,
            etaDays: order.shippingEtaDays,
          },
    totalCents: order.totalCents,
    address: {
      line1: order.shippingLine1,
      line2: order.shippingLine2,
      city: order.shippingCity,
      state: order.shippingState,
      postalCode: order.shippingPostalCode,
    },
  };
}

/**
 * Tells the customer what just happened to their order.
 *
 * Called from OrdersService immediately after a transition's conditional
 * UPDATE reports a row — that row count is the idempotency mechanism, and it
 * is why this service has none of its own: it is only ever reached when the
 * transition really happened on this call (docs/specs/order-emails.md).
 *
 * Nothing here throws. A mail outage must not fail the operation that
 * triggered it — the rule AuthService.register already follows — and here it
 * matters more, because half these sends happen inside a Stripe webhook where
 * any non-2xx is answered with days of redelivery of an event that already
 * took effect.
 *
 * This is also the seam for the post-v1 queue: when BullMQ lands, the try/catch
 * below becomes an enqueue and no call site changes.
 */
@Injectable()
export class OrderNotificationsService {
  private readonly logger = new Logger(OrderNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAIL_SERVICE) private readonly mail: MailService,
  ) {}

  orderPaid(orderId: string): Promise<void> {
    return this.attempt(orderId, 'confirmation', (order) =>
      this.mail.sendOrderPaidEmail(order.user.email, toEmailData(order)),
    );
  }

  orderShipped(orderId: string): Promise<void> {
    return this.attempt(orderId, 'shipment', (order) =>
      this.mail.sendOrderShippedEmail(order.user.email, {
        ...toEmailData(order),
        trackingCode: order.trackingCode,
        trackingUrl: order.trackingUrl,
      }),
    );
  }

  orderRefunded(orderId: string): Promise<void> {
    return this.attempt(orderId, 'refund', (order) =>
      this.mail.sendOrderRefundedEmail(order.user.email, toEmailData(order)),
    );
  }

  orderCancelled(orderId: string): Promise<void> {
    return this.attempt(orderId, 'cancellation', (order) =>
      this.mail.sendOrderCancelledEmail(order.user.email, toEmailData(order)),
    );
  }

  private async attempt(
    orderId: string,
    kind: string,
    send: (order: NotifiableOrder) => Promise<void>,
  ): Promise<void> {
    try {
      const order: NotifiableOrder | null = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: EMAIL_SELECT,
      });

      if (!order) {
        // The transition that called us just succeeded against this id, so a
        // miss here means the row went away underneath — worth a line, not an
        // error the caller has to handle.
        this.logger.warn(
          `Could not send the ${kind} email: order ${orderId} no longer exists`,
        );

        return;
      }

      await send(order);
    } catch (error: unknown) {
      // The id, never the address: an error log is not the place to accumulate
      // customer emails, the same reason the auth logs keep tokens out.
      this.logger.error(
        `Could not send the ${kind} email for order ${orderId}: ${describe(error)}`,
      );
    }
  }
}
