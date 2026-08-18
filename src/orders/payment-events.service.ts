import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { OrderStatus } from '../generated/prisma/enums';
import type { PaymentEvent } from '../payments/payment-provider';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from './orders.service';

/** Prisma's unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

export type WebhookOutcome = 'processed' | 'duplicate';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/**
 * Turns a verified payment event into a change to an order — the domain half
 * of the webhook, with no knowledge of Stripe (see docs/specs/payments.md).
 *
 * Every event is recorded before it is acted on and stamped processed only
 * after, which is what makes redelivery safe in both directions: a duplicate
 * of something finished is answered immediately, while a duplicate of something
 * that died halfway through is genuinely retried.
 */
@Injectable()
export class PaymentEventsService {
  private readonly logger = new Logger(PaymentEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {}

  async handle(event: PaymentEvent): Promise<WebhookOutcome> {
    const orderId = await this.resolveOrderId(event);

    if (!(await this.claim(event, orderId))) {
      return 'duplicate';
    }

    await this.dispatch(event, orderId);

    await this.prisma.paymentEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date() },
    });

    return 'processed';
  }

  /**
   * Session events name the order directly; charge-level ones only know the
   * intent, and the order is whoever stored that intent when it was paid.
   */
  private async resolveOrderId(event: PaymentEvent): Promise<string | null> {
    if ('orderId' in event && event.orderId) {
      return event.orderId;
    }

    if ('paymentIntentRef' in event) {
      const order = await this.prisma.order.findFirst({
        where: { paymentIntentRef: event.paymentIntentRef },
        select: { id: true },
      });

      return order?.id ?? null;
    }

    return null;
  }

  /** False when this event has already been processed to completion. */
  private async claim(
    event: PaymentEvent,
    orderId: string | null,
  ): Promise<boolean> {
    try {
      await this.prisma.paymentEvent.create({
        // The provider's own event name, not our domain outcome: the audit
        // trail is more useful naming what actually arrived (charge.refunded,
        // customer.created) than labelling half the rows "ignored".
        data: { id: event.id, type: event.providerType, orderId },
      });

      return true;
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      const seen = await this.prisma.paymentEvent.findUnique({
        where: { id: event.id },
        select: { processedAt: true },
      });

      // Seen but never finished — a crash between insert and dispatch. Letting
      // this through is the whole reason the two timestamps are separate.
      return seen?.processedAt == null;
    }
  }

  private async dispatch(
    event: PaymentEvent,
    orderId: string | null,
  ): Promise<void> {
    switch (event.type) {
      case 'payment.succeeded':
        await this.applyPayment(orderId, event.paymentIntentRef);
        break;

      case 'payment.refunded':
        await this.applyRefund(orderId, event.refundRef);
        break;

      case 'payment.failed':
      case 'payment.expired':
        // Recorded, and nothing else. An unpaid order stays CREATED and keeps
        // its stock; the buyer (or an operator) asks for a new session via
        // POST /orders/:id/pay. Abandoning it is still a human decision — see
        // the deferred auto-cancel in docs/specs/payments.md.
        this.logger.log(
          `Payment ${event.type} for order ${orderId ?? 'unknown'} — order left untouched`,
        );
        break;

      case 'ignored':
        break;
    }
  }

  private async applyPayment(
    orderId: string | null,
    paymentIntentRef: string,
  ): Promise<void> {
    if (!orderId) {
      this.logger.warn(
        `A payment succeeded for intent ${paymentIntentRef} but no order claims it`,
      );

      return;
    }

    try {
      await this.orders.markPaid(orderId, paymentIntentRef);
    } catch (error: unknown) {
      if (error instanceof NotFoundException) {
        this.logger.warn(
          `A payment succeeded for order ${orderId}, which does not exist here`,
        );

        return;
      }

      // A state conflict must NOT reach the provider as an error: it would
      // redeliver this event for days over something already settled.
      if (error instanceof ConflictException) {
        await this.reportUnpayableOrder(orderId, paymentIntentRef);

        return;
      }

      // Anything else genuinely failed, and the redelivery is our retry.
      throw error;
    }
  }

  private async applyRefund(
    orderId: string | null,
    refundRef: string | null,
  ): Promise<void> {
    if (!orderId) {
      // A refund names only the intent, and the intent is recorded by the
      // SUCCESS event — so an unresolvable refund usually means the two arrived
      // out of order, not that the payment is foreign. Swallowing it would
      // stamp the event processed and leave the order PAID forever after the
      // money went back. Throwing keeps it unprocessed and makes the provider
      // redeliver, by which time the payment will have registered.
      this.logger.warn(
        'A refund arrived for a payment no order claims yet — refusing it so the provider redelivers',
      );

      throw new ServiceUnavailableException(
        'Refund refers to a payment that is not registered yet',
      );
    }

    const applied = await this.orders.markRefunded(orderId, refundRef);

    if (!applied) {
      this.logger.log(
        `Refund event for order ${orderId} found it was not PAID — already refunded, most likely by the route that started this`,
      );
    }
  }

  private async reportUnpayableOrder(
    orderId: string,
    paymentIntentRef: string,
  ): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, paymentIntentRef: true },
    });

    if (order?.status === OrderStatus.PAID) {
      // Same intent means a redelivery the event table did not absorb —
      // routine, nothing moved. A DIFFERENT intent means this order was
      // genuinely charged twice, and the only way anyone can reverse the
      // second charge is if its id appears here: payment_events stores no
      // payload, and the order column already holds the first one.
      if (order.paymentIntentRef === paymentIntentRef) {
        this.logger.log(
          `Order ${orderId} was already PAID when the same payment event arrived again`,
        );

        return;
      }

      this.logger.error(
        `Order ${orderId} was already PAID by ${order.paymentIntentRef ?? 'an unrecorded payment'} ` +
          `when a SECOND payment ${paymentIntentRef} arrived — the buyer was charged twice and ` +
          `${paymentIntentRef} needs a manual refund`,
      );

      return;
    }

    this.logger.error(
      `A payment succeeded for order ${orderId}, which is ${order?.status ?? 'missing'} — ` +
        'money was taken for an order that cannot accept it, and needs a manual refund',
    );
  }
}
