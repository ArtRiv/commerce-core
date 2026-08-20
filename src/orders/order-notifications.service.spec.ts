import { Logger } from '@nestjs/common';

// No cast on the way in: the mock below satisfies MailService structurally,
// which is the point — a method added to the interface breaks this file.
import type {
  OrderEmailData,
  OrderShippedEmailData,
} from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import { OrderNotificationsService } from './order-notifications.service';

/** The shape the service selects — a row plus the account it belongs to. */
function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    itemsSubtotalCents: 4500,
    shippingCents: 1990,
    totalCents: 6490,
    shippingMethodCode: 'padrao-brasil',
    shippingMethodName: 'Entrega padrão',
    shippingEtaDays: 10,
    shippingLine1: 'Rua das Flores, 123',
    shippingLine2: null,
    shippingCity: 'Curitiba',
    shippingState: 'PR',
    shippingPostalCode: '80000-000',
    trackingCode: null,
    trackingUrl: null,
    user: { email: 'cliente@example.com', name: 'Ana' },
    items: [
      { productName: 'Camiseta Azul', unitPriceCents: 1000, quantity: 2 },
      { productName: 'Caneca', unitPriceCents: 2500, quantity: 1 },
    ],
    ...overrides,
  };
}

function createMocks() {
  const prisma = {
    order: {
      findUnique: jest
        .fn<Promise<ReturnType<typeof orderRow> | null>, [unknown]>()
        .mockResolvedValue(orderRow()),
    },
  };

  const mail = {
    sendVerificationEmail: jest.fn(),
    sendPasswordResetEmail: jest.fn(),
    sendOrderPaidEmail: jest
      .fn<Promise<void>, [string, OrderEmailData]>()
      .mockResolvedValue(undefined),
    sendOrderShippedEmail: jest
      .fn<Promise<void>, [string, OrderShippedEmailData]>()
      .mockResolvedValue(undefined),
    sendOrderRefundedEmail: jest
      .fn<Promise<void>, [string, OrderEmailData]>()
      .mockResolvedValue(undefined),
    sendOrderCancelledEmail: jest
      .fn<Promise<void>, [string, OrderEmailData]>()
      .mockResolvedValue(undefined),
  };

  return { prisma, mail };
}

function serviceWith({ prisma, mail }: ReturnType<typeof createMocks>) {
  return new OrderNotificationsService(
    prisma as unknown as PrismaService,
    mail,
  );
}

/** Silences the deliberate error/warn logging, and hands back the spies. */
function muteLogger() {
  return {
    error: jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined),
    warn: jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined),
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('OrderNotificationsService', () => {
  describe('orderPaid', () => {
    it("sends to the address on the buyer's account", async () => {
      const mocks = createMocks();

      await serviceWith(mocks).orderPaid('order-1');

      expect(mocks.mail.sendOrderPaidEmail).toHaveBeenCalledTimes(1);
      expect(mocks.mail.sendOrderPaidEmail.mock.calls[0][0]).toBe(
        'cliente@example.com',
      );
    });

    it('reads the email through its own query, not the order response', async () => {
      const mocks = createMocks();

      await serviceWith(mocks).orderPaid('order-1');

      // Widening OrdersService's ITEMS_INCLUDE instead would put the customer's
      // address into every GET /orders body, for every operator listing orders.
      const [args] = mocks.prisma.order.findUnique.mock.calls[0] as unknown as [
        { select: { user: { select: Record<string, boolean> } } },
      ];
      expect(args.select.user.select).toMatchObject({
        email: true,
        name: true,
      });
    });

    it('breaks the money into subtotal, freight and total', async () => {
      const mocks = createMocks();

      await serviceWith(mocks).orderPaid('order-1');

      const [, data] = mocks.mail.sendOrderPaidEmail.mock.calls[0];
      expect(data).toMatchObject({
        itemsSubtotalCents: 4500,
        totalCents: 6490,
        freight: {
          cents: 1990,
          methodName: 'Entrega padrão',
          etaDays: 10,
        },
      });
      // The identity the database CHECK also holds: what is charged is what
      // the customer can add up from the email.
      expect(data.itemsSubtotalCents + (data.freight?.cents ?? 0)).toBe(
        data.totalCents,
      );
    });

    it('carries the frozen item snapshots', async () => {
      const mocks = createMocks();

      await serviceWith(mocks).orderPaid('order-1');

      const [, data] = mocks.mail.sendOrderPaidEmail.mock.calls[0];
      expect(data.items).toEqual([
        { productName: 'Camiseta Azul', unitPriceCents: 1000, quantity: 2 },
        { productName: 'Caneca', unitPriceCents: 2500, quantity: 1 },
      ]);
    });

    it('carries the delivery address snapshot', async () => {
      const mocks = createMocks();

      await serviceWith(mocks).orderPaid('order-1');

      const [, data] = mocks.mail.sendOrderPaidEmail.mock.calls[0];
      expect(data.address).toEqual({
        line1: 'Rua das Flores, 123',
        line2: null,
        city: 'Curitiba',
        state: 'PR',
        postalCode: '80000-000',
      });
    });

    it('reports no freight for an order created before the shipping module', async () => {
      const mocks = createMocks();
      mocks.prisma.order.findUnique.mockResolvedValue(
        orderRow({
          shippingMethodCode: null,
          shippingMethodName: null,
          shippingEtaDays: null,
          shippingCents: 0,
          itemsSubtotalCents: 4500,
          totalCents: 4500,
        }),
      );

      await serviceWith(mocks).orderPaid('order-1');

      // Null, not { cents: 0, methodName: null }: the zero is a backfill and
      // the method is genuinely unknown, so the template must say nothing
      // rather than promise free shipping.
      expect(mocks.mail.sendOrderPaidEmail.mock.calls[0][1].freight).toBeNull();
    });

    it('reports free shipping as a real method priced at zero', async () => {
      const mocks = createMocks();
      mocks.prisma.order.findUnique.mockResolvedValue(
        orderRow({ shippingCents: 0, totalCents: 4500 }),
      );

      await serviceWith(mocks).orderPaid('order-1');

      expect(mocks.mail.sendOrderPaidEmail.mock.calls[0][1].freight).toEqual({
        cents: 0,
        methodName: 'Entrega padrão',
        etaDays: 10,
      });
    });

    it('passes a missing customer name through as null', async () => {
      const mocks = createMocks();
      mocks.prisma.order.findUnique.mockResolvedValue(
        orderRow({ user: { email: 'cliente@example.com', name: null } }),
      );

      await serviceWith(mocks).orderPaid('order-1');

      expect(
        mocks.mail.sendOrderPaidEmail.mock.calls[0][1].customerName,
      ).toBeNull();
    });
  });

  describe('orderShipped', () => {
    it('carries both halves of the tracking details', async () => {
      const mocks = createMocks();
      mocks.prisma.order.findUnique.mockResolvedValue(
        orderRow({
          trackingCode: 'BR123456789BR',
          trackingUrl: 'https://rastreio.example.com/BR123456789BR',
        }),
      );

      await serviceWith(mocks).orderShipped('order-1');

      expect(mocks.mail.sendOrderShippedEmail.mock.calls[0][1]).toMatchObject({
        trackingCode: 'BR123456789BR',
        trackingUrl: 'https://rastreio.example.com/BR123456789BR',
      });
    });

    it('still sends for a shipment with no tracking at all', async () => {
      const mocks = createMocks();

      await serviceWith(mocks).orderShipped('order-1');

      expect(mocks.mail.sendOrderShippedEmail).toHaveBeenCalledTimes(1);
      expect(mocks.mail.sendOrderShippedEmail.mock.calls[0][1]).toMatchObject({
        trackingCode: null,
        trackingUrl: null,
      });
    });
  });

  describe('orderRefunded', () => {
    it('states the amount charged, which is what goes back', async () => {
      const mocks = createMocks();

      await serviceWith(mocks).orderRefunded('order-1');

      expect(mocks.mail.sendOrderRefundedEmail.mock.calls[0][1]).toMatchObject({
        totalCents: 6490,
      });
    });
  });

  describe('orderCancelled', () => {
    it('sends the cancellation notice', async () => {
      const mocks = createMocks();

      await serviceWith(mocks).orderCancelled('order-1');

      expect(mocks.mail.sendOrderCancelledEmail).toHaveBeenCalledTimes(1);
    });
  });

  describe('when something goes wrong', () => {
    it('never rejects because the mail provider is down', async () => {
      const logger = muteLogger();
      const mocks = createMocks();
      mocks.mail.sendOrderPaidEmail.mockRejectedValue(new Error('Resend down'));

      // The whole point: this is awaited inside a transition that must not
      // fail, and half of those transitions are Stripe webhooks where any
      // non-2xx buys days of redelivery.
      await expect(
        serviceWith(mocks).orderPaid('order-1'),
      ).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalled();
    });

    it('never rejects because the order could not be read', async () => {
      const logger = muteLogger();
      const mocks = createMocks();
      mocks.prisma.order.findUnique.mockRejectedValue(new Error('DB down'));

      await expect(
        serviceWith(mocks).orderShipped('order-1'),
      ).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalled();
    });

    it('warns and sends nothing when the order has vanished', async () => {
      const logger = muteLogger();
      const mocks = createMocks();
      mocks.prisma.order.findUnique.mockResolvedValue(null);

      await serviceWith(mocks).orderPaid('order-1');

      expect(mocks.mail.sendOrderPaidEmail).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('does not log the customer address it failed to reach', async () => {
      const logger = muteLogger();
      const mocks = createMocks();
      mocks.mail.sendOrderPaidEmail.mockRejectedValue(new Error('Resend down'));

      await serviceWith(mocks).orderPaid('order-1');

      // Same posture as the auth logs keeping tokens out: an error log is not
      // the place to accumulate customer addresses.
      const logged = JSON.stringify(logger.error.mock.calls);
      expect(logged).not.toContain('cliente@example.com');
      expect(logged).toContain('order-1');
    });
  });
});
