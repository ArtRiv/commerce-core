import type { Channel, ConsumeMessage } from 'amqplib';

import {
  COMMERCE_EVENTS_EXCHANGE,
  ORDER_PAID_ROUTING_KEY,
  ORDERS_PAID_QUEUE,
} from '../../messaging/messaging.constants';
import type { RabbitMQService } from '../../messaging/rabbitmq.service';
import { RequestContextService } from '../../observability/request-context.service';
import type { OrderNotificationsService } from '../order-notifications.service';
import type { OrdersService } from '../orders.service';
import { OrderPaidConsumer } from './order-paid.consumer';
import type { OrderPaidEvent } from './order-paid.event';

describe('OrderPaidConsumer', () => {
  let consumer: OrderPaidConsumer;
  let contextService: RequestContextService;
  let mockRabbitMQ: { consume: jest.Mock; publish: jest.Mock };
  let mockNotifications: { orderPaid: jest.Mock };
  let mockOrders: { exportToBlingQuietly: jest.Mock };
  let mockChannel: { ack: jest.Mock; nack: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();

    contextService = new RequestContextService();

    mockRabbitMQ = {
      consume: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockResolvedValue(true),
    };

    mockNotifications = {
      orderPaid: jest.fn().mockResolvedValue(undefined),
    };

    mockOrders = {
      exportToBlingQuietly: jest.fn().mockResolvedValue(undefined),
    };

    mockChannel = {
      ack: jest.fn(),
      nack: jest.fn(),
    };

    consumer = new OrderPaidConsumer(
      mockRabbitMQ as unknown as RabbitMQService,
      mockNotifications as unknown as OrderNotificationsService,
      mockOrders as unknown as OrdersService,
      contextService,
    );
  });

  function createMockMessage(
    payload: object | string,
    headers: Record<string, any> = {},
  ): ConsumeMessage {
    const content =
      typeof payload === 'string'
        ? Buffer.from(payload)
        : Buffer.from(JSON.stringify(payload));

    return {
      content,
      properties: {
        headers,
        contentType: 'application/json',
      },
    } as unknown as ConsumeMessage;
  }

  describe('onModuleInit', () => {
    it('registers consumer on the orders.paid queue', async () => {
      await consumer.onModuleInit();

      expect(mockRabbitMQ.consume).toHaveBeenCalledWith(
        ORDERS_PAID_QUEUE,
        expect.any(Function),
      );
    });
  });

  describe('handleMessage - successful execution', () => {
    it('dispatches notifications, exports to Bling, and manually ACKs the message', async () => {
      const payload: OrderPaidEvent = {
        eventId: 'evt-1',
        orderId: 'order-123',
        occurredAt: '2026-10-09T20:00:00.000Z',
        correlationId: 'trace-abc',
      };
      const msg = createMockMessage(payload);

      let capturedOrderId: string | undefined;
      let capturedCorrelationId: string | undefined;

      mockNotifications.orderPaid.mockImplementation(async () => {
        capturedOrderId = RequestContextService.getOrderId();
        capturedCorrelationId = RequestContextService.getCorrelationId();
      });

      await consumer.handleMessage(msg, mockChannel as unknown as Channel);

      expect(mockNotifications.orderPaid).toHaveBeenCalledWith('order-123');
      expect(mockOrders.exportToBlingQuietly).toHaveBeenCalledWith('order-123');
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(mockChannel.nack).not.toHaveBeenCalled();
      expect(capturedOrderId).toBe('order-123');
      expect(capturedCorrelationId).toBe('trace-abc');
    });
  });

  describe('handleMessage - malformed message', () => {
    it('NACKs directly with requeue=false to route unparseable messages to DLQ', async () => {
      const msg = createMockMessage('invalid-json{{{');

      await consumer.handleMessage(msg, mockChannel as unknown as Channel);

      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
      expect(mockChannel.ack).not.toHaveBeenCalled();
      expect(mockNotifications.orderPaid).not.toHaveBeenCalled();
      expect(mockOrders.exportToBlingQuietly).not.toHaveBeenCalled();
    });
  });

  describe('handleMessage - error handling and retries', () => {
    const payload: OrderPaidEvent = {
      eventId: 'evt-2',
      orderId: 'order-fail',
      occurredAt: '2026-10-09T20:00:00.000Z',
    };

    it('republishes with incremented x-retries and ACKs old message when retries < MAX_RETRY_COUNT', async () => {
      mockNotifications.orderPaid.mockRejectedValue(
        new Error('Resend 503 Outage'),
      );
      const msg = createMockMessage(payload, { 'x-retries': 0 });

      await consumer.handleMessage(msg, mockChannel as unknown as Channel);

      expect(mockRabbitMQ.publish).toHaveBeenCalledWith(
        COMMERCE_EVENTS_EXCHANGE,
        ORDER_PAID_ROUTING_KEY,
        payload,
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-retries': 1,
            'x-last-error': 'Resend 503 Outage',
          }),
        }),
      );
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(mockChannel.nack).not.toHaveBeenCalled();
    });

    it('NACKs with requeue=false to route to DLQ when max retries is reached', async () => {
      mockNotifications.orderPaid.mockRejectedValue(
        new Error('Persistent error'),
      );
      const msg = createMockMessage(payload, { 'x-retries': 3 });

      await consumer.handleMessage(msg, mockChannel as unknown as Channel);

      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
      expect(mockChannel.ack).not.toHaveBeenCalled();
      expect(mockRabbitMQ.publish).not.toHaveBeenCalled();
    });
  });
});
