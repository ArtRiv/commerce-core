import type { ConsumeMessage } from 'amqplib';

import { RequestContextService } from '../observability/request-context.service';
import { OrderEventsProducer } from '../orders/messaging/order-events.producer';
import { OrderPaidConsumer } from '../orders/messaging/order-paid.consumer';
import type { OrderNotificationsService } from '../orders/order-notifications.service';
import type { OrdersService } from '../orders/orders.service';
import {
  COMMERCE_EVENTS_DLX,
  COMMERCE_EVENTS_EXCHANGE,
  ORDER_PAID_DLQ_ROUTING_KEY,
  ORDER_PAID_ROUTING_KEY,
  ORDERS_PAID_DLQ,
  ORDERS_PAID_QUEUE,
} from './messaging.constants';
import { RabbitMQService } from './rabbitmq.service';

describe('RabbitMQ Messaging Integration Flow', () => {
  let rabbitmqService: RabbitMQService;
  let producer: OrderEventsProducer;
  let consumer: OrderPaidConsumer;
  let contextService: RequestContextService;

  let mockConfig: { get: jest.Mock };
  let mockNotifications: { orderPaid: jest.Mock };
  let mockOrders: {
    markPaid: jest.Mock;
    exportToBlingQuietly: jest.Mock;
  };

  let mockChannel: any;
  let mockConnection: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConfig = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'RABBITMQ_URL') return 'amqp://localhost:5672';
        return undefined;
      }),
    };

    mockChannel = {
      assertExchange: jest.fn().mockResolvedValue(undefined),
      assertQueue: jest.fn().mockResolvedValue(undefined),
      bindQueue: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockReturnValue(true),
      prefetch: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn().mockResolvedValue({ consumerTag: 'tag-test' }),
      ack: jest.fn(),
      nack: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };

    mockConnection = {
      createChannel: jest.fn().mockResolvedValue(mockChannel),
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };

    rabbitmqService = new RabbitMQService(mockConfig as any);
    // Wire connection manually for clean in-memory integration
    (rabbitmqService as any).connection = mockConnection;
    (rabbitmqService as any).channel = mockChannel;

    contextService = new RequestContextService();

    mockNotifications = {
      orderPaid: jest.fn().mockResolvedValue(undefined),
    };

    mockOrders = {
      markPaid: jest.fn(),
      exportToBlingQuietly: jest.fn().mockResolvedValue(undefined),
    };

    producer = new OrderEventsProducer(rabbitmqService);
    consumer = new OrderPaidConsumer(
      rabbitmqService,
      mockNotifications as unknown as OrderNotificationsService,
      mockOrders as unknown as OrdersService,
      contextService,
    );
  });

  it('initializes AMQP topology with Main Exchange, DLX and Dead Letter Queue', async () => {
    await rabbitmqService.setupTopology(mockChannel);

    expect(mockChannel.assertExchange).toHaveBeenCalledWith(
      COMMERCE_EVENTS_DLX,
      'topic',
      { durable: true },
    );
    expect(mockChannel.assertQueue).toHaveBeenCalledWith(ORDERS_PAID_DLQ, {
      durable: true,
    });
    expect(mockChannel.bindQueue).toHaveBeenCalledWith(
      ORDERS_PAID_DLQ,
      COMMERCE_EVENTS_DLX,
      ORDER_PAID_DLQ_ROUTING_KEY,
    );

    expect(mockChannel.assertExchange).toHaveBeenCalledWith(
      COMMERCE_EVENTS_EXCHANGE,
      'topic',
      { durable: true },
    );
    expect(mockChannel.assertQueue).toHaveBeenCalledWith(ORDERS_PAID_QUEUE, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': COMMERCE_EVENTS_DLX,
        'x-dead-letter-routing-key': ORDER_PAID_DLQ_ROUTING_KEY,
      },
    });
    expect(mockChannel.bindQueue).toHaveBeenCalledWith(
      ORDERS_PAID_QUEUE,
      COMMERCE_EVENTS_EXCHANGE,
      ORDER_PAID_ROUTING_KEY,
    );
  });

  it('runs complete end-to-end event flow: produce -> consume -> side effects -> manual ACK', async () => {
    // 1. Consumer boots up and registers listener
    await consumer.onModuleInit();
    expect(mockChannel.consume).toHaveBeenCalledWith(
      ORDERS_PAID_QUEUE,
      expect.any(Function),
      expect.objectContaining({ noAck: false }),
    );

    // 2. Order is paid: producer sends order.paid event
    const event = {
      eventId: 'evt-integ-1',
      orderId: 'order-integ-1',
      paymentIntentRef: 'pi_test_integ',
      occurredAt: new Date().toISOString(),
      correlationId: 'corr-integ-999',
    };

    const published = producer.publishOrderPaid(event);
    expect(published).toBe(true);

    // Verify producer published with required AMQP routing
    expect(mockChannel.publish).toHaveBeenCalledWith(
      COMMERCE_EVENTS_EXCHANGE,
      ORDER_PAID_ROUTING_KEY,
      expect.any(Buffer),
      expect.objectContaining({
        persistent: true,
        contentType: 'application/json',
        messageId: 'evt-integ-1',
      }),
    );

    // 3. Simulate message delivery to consumer worker
    const messagePayload = Buffer.from(JSON.stringify(event));
    const consumeMessage: ConsumeMessage = {
      content: messagePayload,
      properties: {
        headers: { 'x-retries': 0 },
        contentType: 'application/json',
      },
    } as unknown as ConsumeMessage;

    await consumer.handleMessage(consumeMessage, mockChannel);

    // 4. Verify side effects were triggered asynchronously
    expect(mockNotifications.orderPaid).toHaveBeenCalledWith('order-integ-1');
    expect(mockOrders.exportToBlingQuietly).toHaveBeenCalledWith(
      'order-integ-1',
    );

    // 5. Verify manual ACK was sent
    expect(mockChannel.ack).toHaveBeenCalledWith(consumeMessage);
    expect(mockChannel.nack).not.toHaveBeenCalled();
  });

  it('routes to Dead Letter Queue (DLQ) via NACK with requeue=false when max retries exceeded', async () => {
    await consumer.onModuleInit();

    mockNotifications.orderPaid.mockRejectedValue(
      new Error('Resend persistent 500'),
    );

    const event = {
      eventId: 'evt-dlq-1',
      orderId: 'order-dlq-1',
      occurredAt: new Date().toISOString(),
    };

    const consumeMessage: ConsumeMessage = {
      content: Buffer.from(JSON.stringify(event)),
      properties: {
        headers: { 'x-retries': 3 }, // Max retry count
        contentType: 'application/json',
      },
    } as unknown as ConsumeMessage;

    await consumer.handleMessage(consumeMessage, mockChannel);

    // Should NOT ack, should NACK with requeue: false
    expect(mockChannel.ack).not.toHaveBeenCalled();
    expect(mockChannel.nack).toHaveBeenCalledWith(consumeMessage, false, false);
  });
});
