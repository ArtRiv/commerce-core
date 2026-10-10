import { Injectable, Logger } from '@nestjs/common';

import {
  COMMERCE_EVENTS_EXCHANGE,
  ORDER_PAID_ROUTING_KEY,
} from '../../messaging/messaging.constants';
import { RabbitMQService } from '../../messaging/rabbitmq.service';
import type { OrderPaidEvent } from './order-paid.event';

@Injectable()
export class OrderEventsProducer {
  private readonly logger = new Logger(OrderEventsProducer.name);

  constructor(private readonly rabbitmq: RabbitMQService) {}

  /**
   * Publishes an order.paid event asynchronously to the RabbitMQ exchange.
   * This method is non-blocking and guarantees that broker failures do not
   * crash or fail the caller's HTTP request.
   */
  publishOrderPaid(event: OrderPaidEvent): boolean {
    try {
      const published = this.rabbitmq.publish(
        COMMERCE_EVENTS_EXCHANGE,
        ORDER_PAID_ROUTING_KEY,
        event,
        {
          messageId: event.eventId,
          correlationId: event.correlationId,
          headers: {
            'x-event-type': 'order.paid',
            'x-event-id': event.eventId,
            'x-order-id': event.orderId,
            ...(event.correlationId
              ? { 'x-correlation-id': event.correlationId }
              : {}),
          },
        },
      );

      if (published) {
        this.logger.log(
          `Event order.paid published for order ${event.orderId} (event ${event.eventId})`,
        );
      } else {
        this.logger.warn(
          `Event order.paid could not be published for order ${event.orderId}: RabbitMQ is offline or disconnected`,
        );
      }

      return published;
    } catch (error) {
      this.logger.error(
        `Error publishing order.paid event for order ${event.orderId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
}
