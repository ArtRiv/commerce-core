import crypto from 'node:crypto';

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';

import {
  COMMERCE_EVENTS_EXCHANGE,
  MAX_RETRY_COUNT,
  ORDER_PAID_ROUTING_KEY,
  ORDERS_PAID_QUEUE,
} from '../../messaging/messaging.constants';
import { RabbitMQService } from '../../messaging/rabbitmq.service';
import { RequestContextService } from '../../observability/request-context.service';
import { OrderNotificationsService } from '../order-notifications.service';
import { OrdersService } from '../orders.service';
import type { OrderPaidEvent } from './order-paid.event';

@Injectable()
export class OrderPaidConsumer implements OnModuleInit {
  private readonly logger = new Logger(OrderPaidConsumer.name);

  constructor(
    private readonly rabbitmq: RabbitMQService,
    private readonly notifications: OrderNotificationsService,
    private readonly orders: OrdersService,
    private readonly contextService: RequestContextService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.rabbitmq.consume(
        ORDERS_PAID_QUEUE,
        this.handleMessage.bind(this),
      );
    } catch (error) {
      this.logger.warn(
        `Failed to start OrderPaidConsumer on queue ${ORDERS_PAID_QUEUE}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async handleMessage(msg: ConsumeMessage, channel: Channel): Promise<void> {
    let payload: OrderPaidEvent;

    try {
      payload = JSON.parse(msg.content.toString('utf-8')) as OrderPaidEvent;
    } catch {
      this.logger.error(
        `Failed to parse message from ${ORDERS_PAID_QUEUE}. Rejecting directly to DLQ.`,
      );
      // Malformed message cannot be processed or retried: route directly to DLQ
      channel.nack(msg, false, false);
      return;
    }

    const { orderId, eventId, correlationId } = payload;
    const activeCorrelationId = correlationId || crypto.randomUUID();

    await this.contextService.run(
      { correlationId: activeCorrelationId, orderId },
      async () => {
        try {
          this.logger.log(
            `[Worker] Processing order.paid for order ${orderId} (event ${eventId})`,
          );

          // 1. Asynchronously dispatch customer confirmation email
          await this.notifications.orderPaid(orderId);

          // 2. Asynchronously prepare and export order to Bling ERP for NF-e emission
          await this.orders.exportToBlingQuietly(orderId);

          // 3. Manual acknowledgment: message successfully processed
          channel.ack(msg);
          this.logger.log(
            `[Worker] Order ${orderId} processed and ACKed successfully`,
          );
        } catch (error) {
          const retries = Number(msg.properties.headers?.['x-retries'] ?? 0);
          const errorMessage =
            error instanceof Error ? error.message : String(error);

          if (retries < MAX_RETRY_COUNT) {
            const nextRetry = retries + 1;
            this.logger.warn(
              `[Worker] Transient error on order.paid for order ${orderId} (attempt ${nextRetry}/${MAX_RETRY_COUNT}): ${errorMessage}. Retrying...`,
            );

            // Re-publish with incremented retry header
            this.rabbitmq.publish(
              COMMERCE_EVENTS_EXCHANGE,
              ORDER_PAID_ROUTING_KEY,
              payload,
              {
                headers: {
                  ...msg.properties.headers,
                  'x-retries': nextRetry,
                  'x-last-error': errorMessage,
                },
              },
            );

            // Acknowledge the old message because the retry copy has been enqueued
            channel.ack(msg);
          } else {
            this.logger.error(
              `[Worker] Max retries (${MAX_RETRY_COUNT}) exceeded for order ${orderId}. NACKing to Dead Letter Queue (DLQ): ${errorMessage}`,
            );

            // NACK without requeue triggers RabbitMQ's DLX configuration, routing to orders.paid.dlq
            channel.nack(msg, false, false);
          }
        }
      },
    );
  }
}
