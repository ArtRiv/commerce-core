import { OrderStatus } from '../../generated/prisma/enums';
import { MercadoLivreWebhookService } from './mercadolivre-webhook.service';

describe('MercadoLivreWebhookService', () => {
  let webhookService: MercadoLivreWebhookService;
  let mockPrisma: any;
  let mockConnector: any;
  let mockStock: any;
  let mockErp: any;

  beforeEach(() => {
    mockPrisma = {
      order: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      user: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'user-ml-1', email: 'comprador@ml.test' }),
      },
      marketplaceItemMapping: {
        findFirst: jest.fn(),
      },
      productVariant: {
        findFirst: jest.fn(),
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'var-1', stockQuantity: 9 }),
      },
      $transaction: jest.fn((callback) => callback(mockPrisma)),
    };

    mockConnector = {
      getOrder: jest.fn().mockResolvedValue({
        id: 200000999,
        status: 'paid',
        date_created: '2026-10-06T12:00:00.000Z',
        total_amount: 199.9,
        shipping_cost: 0,
        order_items: [
          {
            item: {
              id: 'MLB111222',
              title: 'Camiseta Silk',
              variation_id: 12345,
            },
            quantity: 1,
            unit_price: 199.9,
          },
        ],
        buyer: {
          id: 554433,
          nickname: 'COMPRADOR_TESTE',
          email: 'comprador@ml.test',
        },
      }),
      getItem: jest.fn().mockResolvedValue({
        id: 'MLB111222',
        title: 'Camiseta Silk',
        price: 199.9,
        available_quantity: 10,
        status: 'active',
      }),
    };

    mockStock = {
      decrement: jest.fn().mockResolvedValue(true),
    };

    const mockShopeeSync = {
      syncVariantStock: jest.fn().mockResolvedValue(true),
    };

    const mockAmazonSync = {
      syncVariantStock: jest.fn().mockResolvedValue(true),
    };

    mockErp = {
      exportOrder: jest.fn().mockResolvedValue({ erpOrderId: 'bling-123' }),
    };

    webhookService = new MercadoLivreWebhookService(
      mockPrisma,
      mockConnector,
      mockStock,
      mockShopeeSync as any,
      mockAmazonSync as any,
      mockErp,
    );
  });

  it('não duplica pedido se já estiver previamente importado', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'ord-local-1',
      originChannel: 'MERCADO_LIVRE',
      externalOrderId: '200000999',
    });

    const result = await webhookService.processNotification({
      topic: 'orders_v2',
      resource: '/orders/200000999',
      user_id: 12345,
    });

    expect(result.processed).toBe(true);
    expect(result.action).toBe('order_already_imported');
    expect(mockPrisma.order.create).not.toHaveBeenCalled();
  });

  it('importa novo pedido, decrementa estoque atomicamente e cria ordem local', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(null);
    mockPrisma.marketplaceItemMapping.findFirst.mockResolvedValue({
      productId: 'prod-1',
      variantId: 'var-1',
      variant: {
        label: 'M',
        product: { name: 'Camiseta Silk' },
      },
    });

    mockPrisma.order.create.mockResolvedValue({
      id: 'ord-recem-criada',
      status: OrderStatus.PAID,
      totalCents: 19990,
      itemsSubtotalCents: 19990,
      shippingCents: 0,
      paidAt: new Date(),
    });

    const result = await webhookService.processNotification({
      topic: 'orders',
      resource: '/orders/200000999',
      user_id: 12345,
    });

    expect(result.processed).toBe(true);
    expect(result.action).toBe('order_imported_successfully');
    expect(mockStock.decrement).toHaveBeenCalledWith('var-1', 1, mockPrisma);
    expect(mockPrisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          originChannel: 'MERCADO_LIVRE',
          externalOrderId: '200000999',
          status: OrderStatus.PAID,
        }),
      }),
    );
    expect(mockErp.exportOrder).toHaveBeenCalled();
  });

  it('processa tópico de items com sucesso', async () => {
    const result = await webhookService.processNotification({
      topic: 'items',
      resource: '/items/MLB111222',
      user_id: 12345,
    });

    expect(result.processed).toBe(true);
    expect(result.action).toBe('item_synced');
    expect(mockConnector.getItem).toHaveBeenCalledWith('MLB111222', 'default');
  });
});
