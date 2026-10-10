import type { ConfigService } from '@nestjs/config';
import amqp from 'amqplib';

import {
  COMMERCE_EVENTS_DLX,
  COMMERCE_EVENTS_EXCHANGE,
  DEFAULT_RABBITMQ_URL,
  ORDER_PAID_DLQ_ROUTING_KEY,
  ORDER_PAID_ROUTING_KEY,
  ORDERS_PAID_DLQ,
  ORDERS_PAID_QUEUE,
} from './messaging.constants';
import { RabbitMQService } from './rabbitmq.service';

jest.mock('amqplib');

describe('RabbitMQService', () => {
  let service: RabbitMQService;
  let mockConfig: { get: jest.Mock };
  let mockConnection: any;
  let mockChannel: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConfig = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'RABBITMQ_URL') return 'amqp://custom:5672';
        return undefined;
      }),
    };

    mockChannel = {
      assertExchange: jest.fn().mockResolvedValue(undefined),
      assertQueue: jest.fn().mockResolvedValue(undefined),
      bindQueue: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockReturnValue(true),
      prefetch: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn().mockResolvedValue({ consumerTag: 'tag-1' }),
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };

    mockConnection = {
      createChannel: jest.fn().mockResolvedValue(mockChannel),
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };

    (amqp.connect as jest.Mock).mockResolvedValue(mockConnection);

    service = new RabbitMQService(mockConfig as unknown as ConfigService);
  });

  describe('onModuleInit and connect', () => {
    it('connects to configured RABBITMQ_URL and asserts topology with DLX and DLQ', async () => {
      await service.onModuleInit();

      expect(amqp.connect).toHaveBeenCalledWith('amqp://custom:5672');
      expect(service.isConnected()).toBe(true);

      // Verify DLX and DLQ
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

      // Verify Main Exchange and Main Queue with DLX
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

    it('falls back to DEFAULT_RABBITMQ_URL when config is unset', async () => {
      mockConfig.get.mockReturnValue(undefined);

      await service.onModuleInit();

      expect(amqp.connect).toHaveBeenCalledWith(DEFAULT_RABBITMQ_URL);
    });

    it('handles connection failure gracefully without throwing', async () => {
      (amqp.connect as jest.Mock).mockRejectedValue(
        new Error('Broker unreachable'),
      );

      await expect(service.onModuleInit()).resolves.not.toThrow();
      expect(service.isConnected()).toBe(false);
    });

    it('skips connection if RABBITMQ_ENABLED is false', async () => {
      mockConfig.get.mockImplementation((key: string) => {
        if (key === 'RABBITMQ_ENABLED') return 'false';
        return undefined;
      });

      await service.onModuleInit();

      expect(amqp.connect).not.toHaveBeenCalled();
      expect(service.isConnected()).toBe(false);
    });
  });

  describe('publish', () => {
    it('publishes formatted message with JSON headers and persistence', async () => {
      await service.connect();

      const success = service.publish('test.exchange', 'test.key', {
        foo: 'bar',
      });

      expect(success).toBe(true);
      expect(mockChannel.publish).toHaveBeenCalledWith(
        'test.exchange',
        'test.key',
        Buffer.from(JSON.stringify({ foo: 'bar' })),
        expect.objectContaining({
          persistent: true,
          contentType: 'application/json',
          timestamp: expect.any(Number),
        }),
      );
    });

    it('returns false and does not throw when disconnected', () => {
      const success = service.publish('test.exchange', 'test.key', {
        foo: 'bar',
      });

      expect(success).toBe(false);
      expect(mockChannel.publish).not.toHaveBeenCalled();
    });
  });

  describe('consume', () => {
    it('creates dedicated channel, sets prefetch and registers consumer callback', async () => {
      await service.connect();

      const handler = jest.fn();
      await service.consume('test.queue', handler);

      expect(mockConnection.createChannel).toHaveBeenCalledTimes(2); // 1 default, 1 consumer
      expect(mockChannel.prefetch).toHaveBeenCalledWith(10);
      expect(mockChannel.consume).toHaveBeenCalledWith(
        'test.queue',
        expect.any(Function),
        expect.objectContaining({ noAck: false }),
      );
    });

    it('gracefully skips if disconnected', async () => {
      const handler = jest.fn();
      await service.consume('test.queue', handler);

      expect(mockChannel.consume).not.toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy and disconnect', () => {
    it('closes consumer channels, default channel and connection', async () => {
      await service.connect();
      await service.consume('test.queue', jest.fn());

      await service.onModuleDestroy();

      expect(mockChannel.close).toHaveBeenCalled();
      expect(mockConnection.close).toHaveBeenCalled();
      expect(service.isConnected()).toBe(false);
    });
  });
});
