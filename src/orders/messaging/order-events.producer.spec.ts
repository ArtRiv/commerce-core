import {
  COMMERCE_EVENTS_EXCHANGE,
  ORDER_PAID_ROUTING_KEY,
} from '../../messaging/messaging.constants';
import type { RabbitMQService } from '../../messaging/rabbitmq.service';
import { OrderEventsProducer } from './order-events.producer';
import type { OrderPaidEvent } from './order-paid.event';

describe('OrderEventsProducer', () => {
  let producer: OrderEventsProducer;
  let mockRabbitMQ: { publish: jest.Mock };

  beforeEach(() => {
    mockRabbitMQ = {
      publish: jest.fn().mockReturnValue(true),
    };
    producer = new OrderEventsProducer(
      mockRabbitMQ as unknown as RabbitMQService,
    );
  });

  const sampleEvent: OrderPaidEvent = {
    eventId: 'evt-123',
    orderId: 'order-999',
    paymentIntentRef: 'pi_test_123',
    occurredAt: '2026-10-09T20:00:00.000Z',
    correlationId: 'req-corr-456',
  };

  it('publishes order.paid event with appropriate exchange, routing key and headers', () => {
    const result = producer.publishOrderPaid(sampleEvent);

    expect(result).toBe(true);
    expect(mockRabbitMQ.publish).toHaveBeenCalledWith(
      COMMERCE_EVENTS_EXCHANGE,
      ORDER_PAID_ROUTING_KEY,
      sampleEvent,
      expect.objectContaining({
        messageId: 'evt-123',
        correlationId: 'req-corr-456',
        headers: expect.objectContaining({
          'x-event-type': 'order.paid',
          'x-event-id': 'evt-123',
          'x-order-id': 'order-999',
          'x-correlation-id': 'req-corr-456',
        }),
      }),
    );
  });

  it('returns false and does not throw when rabbitmq returns false (e.g. disconnected)', () => {
    mockRabbitMQ.publish.mockReturnValue(false);

    const result = producer.publishOrderPaid(sampleEvent);

    expect(result).toBe(false);
  });

  it('returns false and swallows exception when rabbitmq throws an unexpected error', () => {
    mockRabbitMQ.publish.mockImplementation(() => {
      throw new Error('Broker socket closed');
    });

    const result = producer.publishOrderPaid(sampleEvent);

    expect(result).toBe(false);
  });
});
