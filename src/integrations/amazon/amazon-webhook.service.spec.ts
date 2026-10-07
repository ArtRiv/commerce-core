import { Test, TestingModule } from '@nestjs/testing';

import { StockService } from '../../catalog/stock.service';
import { ERP_SERVICE } from '../../erp/erp-service';
import { PrismaService } from '../../prisma/prisma.service';
import { MercadoLivreSyncService } from '../mercadolivre/mercadolivre-sync.service';
import { ShopeeSyncService } from '../shopee/shopee-sync.service';
import { AmazonConnector, type AmazonOrderPayload } from './amazon-connector';
import { AmazonDppService } from './amazon-dpp.service';
import { AmazonWebhookService } from './amazon-webhook.service';

describe('AmazonWebhookService', () => {
  let service: AmazonWebhookService;
  let prisma: PrismaService;
  let stock: StockService;
  let meliSync: MercadoLivreSyncService;
  let shopeeSync: ShopeeSyncService;
  let erp: any;

  const mockAmazonOrder: AmazonOrderPayload = {
    AmazonOrderId: '701-9988776-5544332',
    OrderStatus: 'Unshipped',
    PurchaseDate: new Date().toISOString(),
    OrderTotal: { Amount: '219.80', CurrencyCode: 'BRL' },
    ShippingPrice: { Amount: '29.90', CurrencyCode: 'BRL' },
    BuyerInfo: {
      name: 'Comprador Amazon Teste',
      email: 'comprador@marketplace.amazon.com',
      phone: '+5511999998888',
      taxRegistrationId: '111.222.333-44',
    },
    ShippingAddress: {
      Name: 'Comprador Amazon Teste',
      AddressLine1: 'Av. Paulista, 1000',
      AddressLine2: 'Apto 101',
      City: 'São Paulo',
      StateOrRegion: 'SP',
      PostalCode: '01310-100',
      CountryCode: 'BR',
    },
    OrderItems: [
      {
        OrderItemId: 'item-1',
        SellerSKU: 'SKU-AMAZON-1',
        Title: 'Camiseta Oversized Preta - G',
        QuantityOrdered: 1,
        ItemPrice: { Amount: '189.90', CurrencyCode: 'BRL' },
      },
    ],
  };

  beforeEach(async () => {
    erp = {
      exportOrder: jest.fn().mockResolvedValue({ id: 'bling-order-123' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AmazonWebhookService,
        {
          provide: PrismaService,
          useValue: {
            order: {
              findFirst: jest.fn(),
            },
            user: {
              findFirst: jest.fn().mockResolvedValue({
                id: 'user-cust-1',
                email: 'test@avesso.test',
              }),
            },
            marketplaceItemMapping: {
              findFirst: jest.fn().mockResolvedValue({
                productId: 'prod-1',
                variantId: 'var-1',
                variant: {
                  label: 'G',
                  product: { name: 'Camiseta Oversized Preta' },
                },
              }),
            },
            productVariant: {
              findUnique: jest.fn().mockResolvedValue({ stockQuantity: 9 }),
              findFirst: jest.fn(),
            },
            $transaction: jest.fn().mockImplementation(async (cb: any) => {
              const tx = {
                order: {
                  create: jest.fn().mockResolvedValue({
                    id: 'ord-amazon-created-1',
                    originChannel: 'AMAZON',
                    externalOrderId: '701-9988776-5544332',
                    status: 'PAID',
                    totalCents: 21980,
                    itemsSubtotalCents: 18990,
                    shippingCents: 2990,
                    shippingMethodName: 'Amazon Prime / Entrega Padrão',
                    paidAt: new Date(),
                  }),
                },
              };
              return cb(tx);
            }),
          },
        },
        {
          provide: AmazonConnector,
          useValue: {
            getOrder: jest.fn().mockResolvedValue(mockAmazonOrder),
          },
        },
        {
          provide: AmazonDppService,
          useValue: {
            encryptBuyerPii: jest
              .fn()
              .mockReturnValue('encrypted-buyer-pii-string'),
          },
        },
        {
          provide: StockService,
          useValue: {
            decrement: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: MercadoLivreSyncService,
          useValue: {
            syncVariantStock: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: ShopeeSyncService,
          useValue: {
            syncVariantStock: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: ERP_SERVICE,
          useValue: erp,
        },
      ],
    }).compile();

    service = module.get<AmazonWebhookService>(AmazonWebhookService);
    prisma = module.get<PrismaService>(PrismaService);
    stock = module.get<StockService>(StockService);
    meliSync = module.get<MercadoLivreSyncService>(MercadoLivreSyncService);
    shopeeSync = module.get<ShopeeSyncService>(ShopeeSyncService);
  });

  it('deve retornar idempotência caso pedido já tenha sido importado', async () => {
    jest.spyOn(prisma.order, 'findFirst').mockResolvedValueOnce({
      id: 'ord-existing-amazon',
      originChannel: 'AMAZON',
      externalOrderId: '701-9988776-5544332',
    } as any);

    const result = await service.processNotification({
      NotificationType: 'ORDER_CHANGE',
      Payload: {
        OrderChangeNotification: {
          AmazonOrderId: '701-9988776-5544332',
        },
      },
    });

    expect(result.processed).toBe(true);
    expect(result.action).toBe('order_already_imported');
    expect(result.orderId).toBe('ord-existing-amazon');
  });

  it('deve importar novo pedido, cifrar PII, baixar estoque e propagar para ML, Shopee e Bling', async () => {
    jest.spyOn(prisma.order, 'findFirst').mockResolvedValueOnce(null);

    const result = await service.processNotification({
      NotificationType: 'ORDER_CHANGE',
      Payload: {
        OrderChangeNotification: {
          AmazonOrderId: '701-9988776-5544332',
        },
      },
    });

    expect(result.processed).toBe(true);
    expect(result.action).toBe('order_imported_successfully');
    expect(result.orderId).toBe('ord-amazon-created-1');

    // Verifica decremento atômico de estoque
    expect(stock.decrement).toHaveBeenCalledWith('var-1', 1, expect.anything());

    // Verifica propagação cruzada de estoque
    expect(meliSync.syncVariantStock).toHaveBeenCalledWith('var-1', 9);
    expect(shopeeSync.syncVariantStock).toHaveBeenCalledWith('var-1', 9);

    // Verifica exportação para o ERP
    expect(erp.exportOrder).toHaveBeenCalled();
  });
});
