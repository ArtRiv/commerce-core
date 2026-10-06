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
      disconnect: jest.fn().mockResolvedValue({ disconnected: true }),
      syncCatalog: jest
        .fn()
        .mockResolvedValue({ syncedProducts: 2, totalVariants: 5 }),
      meliWebhook: {
        processNotification: jest.fn().mockResolvedValue({
          processed: true,
          action: 'order_imported_successfully',
        }),
      },
    };

    controller = new IntegrationsController(mockIntegrationsService);
  });

  it('lista integrações com sucesso', async () => {
    const res = await controller.list();
    expect(res.integrations).toHaveLength(1);
    expect(res.integrations[0].provider).toBe('MERCADO_LIVRE');
  });

  it('retorna URL de autorização OAuth', () => {
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

  it('dispara sincronização de catálogo', async () => {
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
});
