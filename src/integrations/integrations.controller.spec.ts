import { IntegrationsController } from './integrations.controller';

describe('IntegrationsController', () => {
  let controller: IntegrationsController;
  let mockIntegrationsService: any;

  beforeEach(() => {
    mockIntegrationsService = {
      listIntegrations: jest.fn().mockResolvedValue({
        integrations: [
          {
            provider: 'MERCADO_LIVRE',
            connected: true,
            status: 'ACTIVE',
            expiresAt: '2026-10-06T18:00:00.000Z',
            metadata: { nickname: 'LOJA_OFICIAL' },
          },
          {
            provider: 'SHOPEE',
            connected: true,
            status: 'ACTIVE',
            expiresAt: '2026-10-06T20:00:00.000Z',
            metadata: { shopId: 654321, shopName: 'Loja Oficial Shopee' },
          },
        ],
      }),
      meliAuth: {
        getAuthorizationUrl: jest
          .fn()
          .mockReturnValue(
            'https://auth.mercadolivre.com.br/authorization?state=123',
          ),
        exchangeAuthorizationCode: jest
          .fn()
          .mockResolvedValue({ tenantId: 'default', nickname: 'LOJA_OFICIAL' }),
      },
      shopeeAuth: {
        getAuthorizationUrl: jest
          .fn()
          .mockReturnValue(
            'https://partner.shopeemobile.com/api/v2/shop/auth_partner?partner_id=123',
          ),
        exchangeAuthorizationCode: jest.fn().mockResolvedValue({
          tenantId: 'default',
          shopId: 654321,
          shopName: 'Loja Oficial Shopee',
        }),
      },
      disconnect: jest.fn().mockResolvedValue({ disconnected: true }),
      syncCatalog: jest
        .fn()
        .mockResolvedValue({ syncedProducts: 2, totalVariants: 5 }),
      syncShopeeCatalog: jest
        .fn()
        .mockResolvedValue({ syncedProducts: 3, totalVariants: 7 }),
      syncAmazonCatalog: jest
        .fn()
        .mockResolvedValue({ syncedProducts: 4, totalVariants: 9 }),
      meliWebhook: {
        processNotification: jest.fn().mockResolvedValue({
          processed: true,
          action: 'order_imported_successfully',
        }),
      },
      shopeeWebhook: {
        verifyPushSignature: jest.fn().mockReturnValue(true),
        processPushNotification: jest.fn().mockResolvedValue({
          processed: true,
          action: 'order_imported_successfully',
        }),
      },
      amazonAuth: {
        getAuthorizationUrl: jest
          .fn()
          .mockReturnValue(
            'https://sellercentral.amazon.com.br/apps/authorize/consent?application_id=123',
          ),
        exchangeAuthorizationCode: jest.fn().mockResolvedValue({
          tenantId: 'default',
          sellingPartnerId: 'A21TJRUUN4KGV',
          marketplaceId: 'A2Q3Y263D00KWC',
        }),
      },
      amazonWebhook: {
        processNotification: jest.fn().mockResolvedValue({
          processed: true,
          action: 'order_imported_successfully',
        }),
      },
    };

    controller = new IntegrationsController(mockIntegrationsService);
  });

  it('lista integrações com sucesso incluindo Mercado Livre e Shopee', async () => {
    const res = await controller.list();
    expect(res.integrations).toHaveLength(2);
    expect(res.integrations[0].provider).toBe('MERCADO_LIVRE');
    expect(res.integrations[1].provider).toBe('SHOPEE');
  });

  it('retorna URL de autorização OAuth do Mercado Livre', () => {
    const res = controller.getMeliAuthUrl();
    expect(res.url).toContain('https://auth.mercadolivre.com.br');
  });

  it('processa callback do Mercado Livre', async () => {
    const res = await controller.meliCallback({
      code: 'auth-code-123',
      state: 'state-abc',
    });
    expect(res.provider).toBe('MERCADO_LIVRE');
    expect(res.connected).toBe(true);
  });

  it('desconecta integração com sucesso', async () => {
    const res = await controller.disconnectMeli();
    expect(res.disconnected).toBe(true);
  });

  it('dispara sincronização de catálogo com Mercado Livre', async () => {
    const res = await controller.syncMeliCatalog();
    expect(res.syncedProducts).toBe(2);
  });

  it('recebe webhook do Mercado Livre', async () => {
    const res = await controller.meliWebhook({
      topic: 'orders_v2',
      resource: '/orders/200000123',
      user_id: 123456,
    });
    expect(res.received).toBe(true);
    expect(res.action).toBe('order_imported_successfully');
  });

  it('retorna URL de autorização da Shopee Open Platform', () => {
    const res = controller.getShopeeAuthUrl();
    expect(res.url).toContain(
      'https://partner.shopeemobile.com/api/v2/shop/auth_partner',
    );
  });

  it('processa callback de autorização da Shopee', async () => {
    const res = await controller.shopeeCallback({
      code: 'sp_code_123',
      shop_id: 654321,
      state: 'state-xyz',
    });
    expect(res.provider).toBe('SHOPEE');
    expect(res.connected).toBe(true);
    expect(res.metadata).toEqual({
      shopId: 654321,
      shopName: 'Loja Oficial Shopee',
    });
  });

  it('desconecta integração com a Shopee', async () => {
    const res = await controller.disconnectShopee();
    expect(res.disconnected).toBe(true);
    expect(mockIntegrationsService.disconnect).toHaveBeenCalledWith(
      'SHOPEE',
      'default',
    );
  });

  it('dispara sincronização de catálogo com a Shopee', async () => {
    const res = await controller.syncShopeeCatalog();
    expect(res.syncedProducts).toBe(3);
    expect(res.totalVariants).toBe(7);
  });

  it('recebe push/webhook da Shopee', async () => {
    const res = await controller.shopeeWebhook(
      {
        code: 3,
        shop_id: 654321,
        timestamp: 1696600000,
        data: { ordersn: '230928ABCDEF1234' },
      },
      'fake-auth-header',
    );
    expect(res.received).toBe(true);
    expect(res.action).toBe('order_imported_successfully');
    expect(
      mockIntegrationsService.shopeeWebhook.verifyPushSignature,
    ).toHaveBeenCalled();
  });

  it('retorna URL de autorização da Amazon LWA', () => {
    const res = controller.getAmazonAuthUrl();
    expect(res.url).toContain('https://sellercentral.amazon.com.br');
  });

  it('processa callback de autorização da Amazon LWA', async () => {
    const res = await controller.amazonCallback({
      spapi_oauth_code: 'spapi-code-123',
      selling_partner_id: 'A21TJRUUN4KGV',
      state: 'state-abc',
    });
    expect(res.provider).toBe('AMAZON');
    expect(res.connected).toBe(true);
    expect(res.metadata).toEqual({
      sellingPartnerId: 'A21TJRUUN4KGV',
      marketplaceId: 'A2Q3Y263D00KWC',
      dppCompliant: true,
    });
  });

  it('desconecta integração com a Amazon SP-API', async () => {
    const res = await controller.disconnectAmazon();
    expect(res.disconnected).toBe(true);
    expect(mockIntegrationsService.disconnect).toHaveBeenCalledWith(
      'AMAZON',
      'default',
    );
  });

  it('dispara sincronização de catálogo com a Amazon SP-API', async () => {
    const res = await controller.syncAmazonCatalog();
    expect(res.syncedProducts).toBe(4);
    expect(res.totalVariants).toBe(9);
  });

  it('recebe notificação assíncrona da Amazon SP-API', async () => {
    const res = await controller.amazonNotifications({
      NotificationType: 'ORDER_CHANGE',
      Payload: {
        OrderChangeNotification: {
          AmazonOrderId: '701-1234567-1234567',
        },
      },
    });
    expect(res.received).toBe(true);
    expect(res.action).toBe('order_imported_successfully');
    expect(
      mockIntegrationsService.amazonWebhook.processNotification,
    ).toHaveBeenCalled();
  });
});
