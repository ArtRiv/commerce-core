import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import amqp, {
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
  type Options,
} from 'amqplib';

import {
  COMMERCE_EVENTS_DLX,
  COMMERCE_EVENTS_EXCHANGE,
  DEFAULT_RABBITMQ_URL,
  ORDER_PAID_DLQ_ROUTING_KEY,
  ORDER_PAID_ROUTING_KEY,
  ORDERS_PAID_DLQ,
  ORDERS_PAID_QUEUE,
} from './messaging.constants';

@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQService.name);
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private readonly consumerChannels: Channel[] = [];
  private connectingPromise: Promise<void> | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const isEnabled = this.config.get<string>('RABBITMQ_ENABLED');
    if (isEnabled === 'false') {
      this.logger.log('RabbitMQ is disabled via RABBITMQ_ENABLED=false');
      return;
    }

    try {
      await this.connect();
    } catch (error) {
      this.logger.warn(
        `Initial RabbitMQ connection failed: ${error instanceof Error ? error.message : String(error)}. Messaging is running in disconnected mode.`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  getRabbitMQUrl(): string {
    return (
      this.config.get<string>('RABBITMQ_URL') ||
      process.env.RABBITMQ_URL ||
      DEFAULT_RABBITMQ_URL
    );
  }

  isConnected(): boolean {
    return this.connection !== null && this.channel !== null;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    if (this.connectingPromise) return this.connectingPromise;

    this.connectingPromise = (async () => {
      const url = this.getRabbitMQUrl();
      this.logger.log(`Connecting to RabbitMQ at ${url}...`);

      const connection = await amqp.connect(url);
      this.connection = connection;

      connection.on('error', (err) => {
        this.logger.error(
          `RabbitMQ connection error: ${err.message}`,
          err.stack,
        );
      });

      connection.on('close', () => {
        this.logger.warn('RabbitMQ connection closed.');
        this.connection = null;
        this.channel = null;
      });

      const channel = await connection.createChannel();
      this.channel = channel;

      channel.on('error', (err) => {
        this.logger.error(
          `RabbitMQ default channel error: ${err.message}`,
          err.stack,
        );
      });

      channel.on('close', () => {
        this.channel = null;
      });

      await this.setupTopology(channel);
      this.logger.log('RabbitMQ connected and topology asserted successfully.');
    })().finally(() => {
      this.connectingPromise = null;
    });

    return this.connectingPromise;
  }

  async setupTopology(channel: Channel): Promise<void> {
    // 1. Assert Dead Letter Exchange (DLX) & Dead Letter Queue (DLQ)
    await channel.assertExchange(COMMERCE_EVENTS_DLX, 'topic', {
      durable: true,
    });
    await channel.assertQueue(ORDERS_PAID_DLQ, { durable: true });
    await channel.bindQueue(
      ORDERS_PAID_DLQ,
      COMMERCE_EVENTS_DLX,
      ORDER_PAID_DLQ_ROUTING_KEY,
    );

    // 2. Assert Main Exchange
    await channel.assertExchange(COMMERCE_EVENTS_EXCHANGE, 'topic', {
      durable: true,
    });

    // 3. Assert Main Queue with Dead Letter routing
    await channel.assertQueue(ORDERS_PAID_QUEUE, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': COMMERCE_EVENTS_DLX,
        'x-dead-letter-routing-key': ORDER_PAID_DLQ_ROUTING_KEY,
      },
    });

    // 4. Bind Main Queue to Main Exchange for order.paid
    await channel.bindQueue(
      ORDERS_PAID_QUEUE,
      COMMERCE_EVENTS_EXCHANGE,
      ORDER_PAID_ROUTING_KEY,
    );
  }

  publish(
    exchange: string,
    routingKey: string,
    message: object | Buffer,
    options?: Options.Publish,
  ): boolean {
    if (!this.isConnected() || !this.channel) {
      this.logger.warn(
        `Cannot publish to ${exchange} [${routingKey}]: RabbitMQ channel not available.`,
      );
      return false;
    }

    const payload = Buffer.isBuffer(message)
      ? message
      : Buffer.from(JSON.stringify(message));

    return this.channel.publish(exchange, routingKey, payload, {
      persistent: true,
      contentType: 'application/json',
      timestamp: Date.now(),
      ...options,
    });
  }

  async consume(
    queue: string,
    handler: (msg: ConsumeMessage, channel: Channel) => Promise<void>,
    options?: Options.Consume,
  ): Promise<void> {
    if (!this.connection) {
      this.logger.warn(
        `Cannot register consumer for queue ${queue}: RabbitMQ not connected.`,
      );
      return;
    }

    const consumerChannel = await this.connection.createChannel();
    this.consumerChannels.push(consumerChannel);

    await consumerChannel.prefetch(10);
    await consumerChannel.consume(
      queue,
      (msg) => {
        if (!msg) return;
        void handler(msg, consumerChannel);
      },
      { noAck: false, ...options },
    );

    this.logger.log(`Consumer registered on queue ${queue}.`);
  }

  async disconnect(): Promise<void> {
    for (const ch of this.consumerChannels) {
      try {
        await ch.close();
      } catch {
        // ignore on shutdown
      }
    }
    this.consumerChannels.length = 0;

    if (this.channel) {
      try {
        await this.channel.close();
      } catch {
        // ignore on shutdown
      }
      this.channel = null;
    }

    if (this.connection) {
      try {
        await this.connection.close();
      } catch {
        // ignore on shutdown
      }
      this.connection = null;
    }
  }

  getChannel(): Channel | null {
    return this.channel;
  }
}
