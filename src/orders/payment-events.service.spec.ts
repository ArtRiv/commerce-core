import {
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { OrderStatus } from '../generated/prisma/enums';
import type { PaymentEvent } from '../payments/payment-provider';
import type { PrismaService } from '../prisma/prisma.service';
import type { OrdersService } from './orders.service';
import { PaymentEventsService } from './payment-events.service';

function uniqueViolation() {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
  });
}

function createPrismaMock() {
  return {
    paymentEvent: {
      create: jest
        .fn<Promise<unknown>, [unknown]>()
        .mockResolvedValue(undefined),
      findUnique: jest
        .fn<Promise<{ processedAt: Date | null } | null>, [unknown]>()
        .mockResolvedValue(null),
      update: jest
        .fn<Promise<unknown>, [unknown]>()
        .mockResolvedValue(undefined),
    },
    order: {
      findFirst: jest
        .fn<Promise<{ id: string } | null>, [unknown]>()
        .mockResolvedValue(null),
      findUnique: jest
        .fn<
          Promise<{
            status: OrderStatus;
            paymentIntentRef: string | null;
          } | null>,
          [unknown]
        >()
        .mockResolvedValue({
          status: OrderStatus.CREATED,
          paymentIntentRef: null,
        }),
    },
  };
}

function createOrdersMock() {
  return {
    markPaid: jest
      .fn<Promise<unknown>, [string, string?]>()
      .mockResolvedValue(undefined),
    markRefunded: jest
      .fn<Promise<boolean>, [string, string | null]>()
      .mockResolvedValue(true),
  };
}

type Mocks = {
  prisma: ReturnType<typeof createPrismaMock>;
  orders: ReturnType<typeof createOrdersMock>;
};

function createMocks(): Mocks {
  return { prisma: createPrismaMock(), orders: createOrdersMock() };
}

function serviceWith({ prisma, orders }: Mocks) {
  return new PaymentEventsService(
    prisma as unknown as PrismaService,
    orders as unknown as OrdersService,
  );
}

const SUCCEEDED: PaymentEvent = {
  id: 'evt_1',
  providerType: 'checkout.session.completed',
  type: 'payment.succeeded',
  orderId: 'order-1',
  paymentIntentRef: 'pi_1',
};

const REFUNDED: PaymentEvent = {
  id: 'evt_2',
  providerType: 'charge.refunded',
  type: 'payment.refunded',
  orderId: null,
  paymentIntentRef: 'pi_1',
  refundRef: 're_1',
};

/** Silences the deliberate logging, and hands back the spies. */
function muteLogger() {
  return {
    error: jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined),
    warn: jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined),
    log: jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined),
  };
}

describe('PaymentEventsService', () => {
  let logger: ReturnType<typeof muteLogger>;

  beforeEach(() => {
    logger = muteLogger();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('records the event, pays the order, then stamps it processed', async () => {
    const mocks = createMocks();

    await expect(serviceWith(mocks).handle(SUCCEEDED)).resolves.toBe(
      'processed',
    );

    const [created] = mocks.prisma.paymentEvent.create.mock.calls[0] as [
      { data: { id: string; type: string; orderId: string | null } },
    ];
    // The audit row records the provider's event name, not our domain outcome.
    expect(created.data).toEqual({
      id: 'evt_1',
      type: 'checkout.session.completed',
      orderId: 'order-1',
    });
    expect(mocks.orders.markPaid).toHaveBeenCalledWith('order-1', 'pi_1');

    // Stamped only after dispatch returned: the gap between the two is what
    // makes a crash mid-dispatch recoverable.
    const [stamped] = mocks.prisma.paymentEvent.update.mock.calls[0] as [
      { where: { id: string }; data: { processedAt: Date } },
    ];
    expect(stamped.where).toEqual({ id: 'evt_1' });
    expect(stamped.data.processedAt).toBeInstanceOf(Date);
  });

  it('answers duplicate for a redelivery of something already finished', async () => {
    const mocks = createMocks();
    mocks.prisma.paymentEvent.create.mockRejectedValue(uniqueViolation());
    mocks.prisma.paymentEvent.findUnique.mockResolvedValue({
      processedAt: new Date(),
    });

    await expect(serviceWith(mocks).handle(SUCCEEDED)).resolves.toBe(
      'duplicate',
    );
    expect(mocks.orders.markPaid).not.toHaveBeenCalled();
  });

  it('reprocesses an event that was seen but never finished', async () => {
    const mocks = createMocks();
    mocks.prisma.paymentEvent.create.mockRejectedValue(uniqueViolation());
    mocks.prisma.paymentEvent.findUnique.mockResolvedValue({
      processedAt: null,
    });

    // The row exists because a previous delivery died between insert and
    // dispatch. Treating it as a duplicate would lose the payment for good,
    // since the provider stops redelivering once it sees a 200.
    await expect(serviceWith(mocks).handle(SUCCEEDED)).resolves.toBe(
      'processed',
    );
    expect(mocks.orders.markPaid).toHaveBeenCalled();
  });

  it('finds the order by intent when the event names no order', async () => {
    const mocks = createMocks();
    mocks.prisma.order.findFirst.mockResolvedValue({ id: 'order-7' });

    await serviceWith(mocks).handle(REFUNDED);

    // charge.refunded — a refund issued from the provider's dashboard —
    // carries the intent and nothing of ours.
    const [lookup] = mocks.prisma.order.findFirst.mock.calls[0] as [
      { where: { paymentIntentRef: string } },
    ];
    expect(lookup.where.paymentIntentRef).toBe('pi_1');
    expect(mocks.orders.markRefunded).toHaveBeenCalledWith('order-7', 're_1');
  });

  it('treats a redelivery of the SAME payment as settled, not as a failure', async () => {
    const mocks = createMocks();
    mocks.orders.markPaid.mockRejectedValue(new ConflictException('already'));
    mocks.prisma.order.findUnique.mockResolvedValue({
      status: OrderStatus.PAID,
      // Same intent already on the order: nothing moved twice.
      paymentIntentRef: 'pi_1',
    });

    // Answering anything but 200 here would have the provider redeliver for
    // days over something already settled.
    await expect(serviceWith(mocks).handle(SUCCEEDED)).resolves.toBe(
      'processed',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('shouts, with the second intent, when an order was charged twice', async () => {
    const mocks = createMocks();
    mocks.orders.markPaid.mockRejectedValue(new ConflictException('already'));
    mocks.prisma.order.findUnique.mockResolvedValue({
      status: OrderStatus.PAID,
      // A DIFFERENT intent — the buyer really was charged a second time.
      paymentIntentRef: 'pi_first',
    });

    await expect(serviceWith(mocks).handle(SUCCEEDED)).resolves.toBe(
      'processed',
    );

    // The order column holds the first intent and payment_events stores no
    // payload, so if this line does not name the second one, nothing does —
    // and the extra charge cannot be refunded without hunting the dashboard.
    const message = String((logger.error.mock.calls[0] as [unknown])[0]);
    expect(message).toContain('pi_1');
    expect(message).toContain('pi_first');
  });

  it('shouts when a payment lands on an order that cannot accept it', async () => {
    const mocks = createMocks();
    mocks.orders.markPaid.mockRejectedValue(new ConflictException('cancelled'));
    mocks.prisma.order.findUnique.mockResolvedValue({
      status: OrderStatus.CANCELLED,
      paymentIntentRef: null,
    });

    await expect(serviceWith(mocks).handle(SUCCEEDED)).resolves.toBe(
      'processed',
    );
    // Money was taken for an order whose stock went back on the shelf. There
    // is no automatic fix; the log is what gets a human to the dashboard.
    expect(logger.error).toHaveBeenCalled();
  });

  it('refuses a refund whose payment is not registered yet, so it is redelivered', async () => {
    const mocks = createMocks();
    // No order carries this intent — almost always because the refund overtook
    // its own payment.succeeded, since the intent is recorded BY that event.
    mocks.prisma.order.findFirst.mockResolvedValue(null);

    await expect(serviceWith(mocks).handle(REFUNDED)).rejects.toThrow(
      ServiceUnavailableException,
    );

    // Never stamped: swallowing this would 200 the provider, stop redelivery,
    // and leave the order PAID forever after the money already went back.
    expect(mocks.prisma.paymentEvent.update).not.toHaveBeenCalled();
    expect(mocks.orders.markRefunded).not.toHaveBeenCalled();
  });

  it('records a payment for an unknown order without failing', async () => {
    const mocks = createMocks();
    mocks.orders.markPaid.mockRejectedValue(new NotFoundException('gone'));

    await expect(serviceWith(mocks).handle(SUCCEEDED)).resolves.toBe(
      'processed',
    );
    expect(logger.warn).toHaveBeenCalled();
  });

  it.each(['payment.failed', 'payment.expired'] as const)(
    'records %s and leaves the order alone',
    async (type) => {
      const mocks = createMocks();

      await serviceWith(mocks).handle({
        id: 'evt_9',
        providerType: `checkout.session.${type === 'payment.failed' ? 'async_payment_failed' : 'expired'}`,
        type,
        orderId: 'order-1',
      });

      // An expired session does not abandon the order: it keeps its stock and
      // POST /orders/:id/pay issues another way to pay.
      expect(mocks.orders.markPaid).not.toHaveBeenCalled();
      expect(mocks.orders.markRefunded).not.toHaveBeenCalled();
      expect(mocks.prisma.paymentEvent.update).toHaveBeenCalled();
    },
  );

  it('records an ignored event and dispatches nothing', async () => {
    const mocks = createMocks();

    await expect(
      serviceWith(mocks).handle({
        id: 'evt_10',
        providerType: 'customer.created',
        type: 'ignored',
      }),
    ).resolves.toBe('processed');
    expect(mocks.orders.markPaid).not.toHaveBeenCalled();
  });

  it('lets an unexpected failure through, unprocessed, so it is redelivered', async () => {
    const mocks = createMocks();
    mocks.orders.markPaid.mockRejectedValue(new Error('database on fire'));

    await expect(serviceWith(mocks).handle(SUCCEEDED)).rejects.toThrow(
      'database on fire',
    );
    // Never stamped, so the redelivery — which is this module's retry — will
    // find work to do rather than a finished row.
    expect(mocks.prisma.paymentEvent.update).not.toHaveBeenCalled();
  });
});
