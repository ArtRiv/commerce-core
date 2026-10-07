import { createHmac } from 'node:crypto';

import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { OrderStatus } from '../../generated/prisma/enums';
import { ShopeeWebhookService } from './shopee-webhook.service';

describe('ShopeeWebhookService', () => {
  let webhookService: ShopeeWebhookService;
  let mockPrisma: any;
  let mockConnector: any;
  let mockStock: any;
  let mockMeliSync: any;
  let mockErp: any;

  beforeEach(() => {
    const config = new ConfigService({
      NODE_ENV: 'test',
      SHOPEE_PARTNER_KEY: 'test-partner-key-secret',
    });

    mockPrisma = {
      order: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'user-shopee-1',
          email: 'shopee_cliente@shopee.test',
        }),
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
        order_sn: '230928ABCDEF1234',
        order_status: 'READY_TO_SHIP',
        create_time: 1696600000,
        total_amount: 149.9,
        actual_shipping_fee: 14.5,
        buyer: {
          buyer_user_id: 887766,
          buyer_username: 'cliente_shopee_br',
        },
        recipient_address: {
          name: 'Lucas Pereira',
          phone: '11988887777',
          full_address: 'Rua Augusta, 500',
          city: 'São Paulo',
          state: 'SP',
          zipcode: '01305-000',
          district: 'Consolação',
        },
        item_list: [
          {
            item_id: 99112233,
            item_name: 'Camiseta Básica Oversized',
            model_id: 554433,
            model_name: 'G',
            model_quantity_purchased: 1,
            model_discounted_price: 149.9,
          },
        ],
      }),
    };

    mockStock = {
      decrement: jest.fn().mockResolvedValue(true),
    };

    mockMeliSync = {
      syncVariantStock: jest.fn().mockResolvedValue({ updatedMappings: 1 }),
    };

    const mockAmazonSync = {
      syncVariantStock: jest.fn().mockResolvedValue(true),
    };

    mockErp = {
      exportOrder: jest
        .fn()
        .mockResolvedValue({ erpOrderId: 'bling-shopee-123' }),
    };

    webhookService = new ShopeeWebhookService(
      config,
      mockPrisma,
      mockConnector,
      mockStock,
      mockMeliSync,
      mockAmazonSync as any,
      mockErp,
    );
  });

  it('valida assinatura correta e rejeita assinatura inválida', () => {
    const rawBody = JSON.stringify({ code: 3, shop_id: 12345 });
    // Gera assinatura válida
    const validSig = createHmac('sha256', 'test-partner-key-secret')
      .update(rawBody)
      .digest('hex');

    expect(webhookService.verifyPushSignature(validSig, rawBody)).toBe(true);

    expect(() =>
      webhookService.verifyPushSignature('invalid-sig-hex', rawBody),
    ).toThrow(UnauthorizedException);
  });

  it('não duplica pedido se já estiver previamente importado na Shopee', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'ord-shopee-antiga',
      originChannel: 'SHOPEE',
      externalOrderId: '230928ABCDEF1234',
    });

    const result = await webhookService.processPushNotification({
      code: 3,
      shop_id: 654321,
      timestamp: 1696600000,
      data: { ordersn: '230928ABCDEF1234' },
    });

    expect(result.processed).toBe(true);
    expect(result.action).toBe('order_already_imported');
    expect(mockPrisma.order.create).not.toHaveBeenCalled();
  });

  it('importa novo pedido da Shopee, decrementa estoque atomicamente, sincroniza com outros marketplaces e exporta para o ERP', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(null);
    mockPrisma.marketplaceItemMapping.findFirst.mockResolvedValue({
      productId: 'prod-1',
      variantId: 'var-1',
      variant: {
        label: 'G',
        product: { name: 'Camiseta Básica Oversized' },
      },
    });

    mockPrisma.order.create.mockResolvedValue({
      id: 'ord-shopee-nova',
      status: OrderStatus.PAID,
      totalCents: 16440,
      itemsSubtotalCents: 14990,
      shippingCents: 1450,
      shippingMethodName: 'Shopee Envio',
      paidAt: new Date(1696600000 * 1000),
    });

    const result = await webhookService.processPushNotification({
      code: 3,
      shop_id: 654321,
      timestamp: 1696600000,
      data: { ordersn: '230928ABCDEF1234' },
    });

    expect(result.processed).toBe(true);
    expect(result.action).toBe('order_imported_successfully');
    expect(mockStock.decrement).toHaveBeenCalledWith('var-1', 1, mockPrisma);
    expect(mockPrisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          originChannel: 'SHOPEE',
          externalOrderId: '230928ABCDEF1234',
          status: OrderStatus.PAID,
          shippingMethodName: 'Shopee Envio',
        }),
      }),
    );
    // Propaga baixa de estoque para o Mercado Livre
    expect(mockMeliSync.syncVariantStock).toHaveBeenCalledWith(
      'var-1',
      9,
      'default',
    );
    // Exporta para o Bling
    expect(mockErp.exportOrder).toHaveBeenCalled();
  });

  it('processa notificação push de atualização de item (código 2)', async () => {
    const result = await webhookService.processPushNotification({
      code: 2,
      shop_id: 654321,
      timestamp: 1696600000,
      data: { item_id: 99112233 },
    });

    expect(result.processed).toBe(true);
    expect(result.action).toBe('item_updated');
  });
});
