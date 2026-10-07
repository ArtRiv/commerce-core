import { ConfigService } from '@nestjs/config';

import { EncryptionService } from '../crypto/encryption.service';
import { ShopeeCategoryMappingService } from './shopee-category-mapping.service';
import { ShopeeConnector } from './shopee-connector';

describe('ShopeeConnector', () => {
  let connector: ShopeeConnector;
  let encryption: EncryptionService;
  let categoryMapping: ShopeeCategoryMappingService;
  let mockPrisma: any;

  beforeEach(() => {
    const config = new ConfigService({
      NODE_ENV: 'test',
      APP_ENCRYPTION_KEY: 'f'.repeat(64),
      SHOPEE_PARTNER_ID: '', // Simulado
      SHOPEE_PARTNER_KEY: '',
    });

    encryption = new EncryptionService(config);
    categoryMapping = new ShopeeCategoryMappingService();

    mockPrisma = {
      tenantIntegration: {
        findUnique: jest.fn(),
      },
      $transaction: jest.fn((callback) => callback(mockPrisma)),
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn(),
    };

    connector = new ShopeeConnector(
      config,
      mockPrisma,
      encryption,
      categoryMapping,
    );
  });

  it('retorna access_token existente se ainda estiver válido e distante da expiração', async () => {
    const validUntil = new Date(Date.now() + 60 * 60 * 1000); // 1 hora no futuro
    const credentials = {
      access_token: 'mock-shopee-token',
      refresh_token: 'mock-shopee-refresh-1',
      expire_in: 14400,
      shop_id: 112233,
    };

    mockPrisma.tenantIntegration.findUnique.mockResolvedValue({
      id: 'integ-shopee-1',
      tenantId: 'default',
      provider: 'SHOPEE',
      status: 'ACTIVE',
      expiresAt: validUntil,
      credentialsEncrypted: encryption.encryptJson(credentials),
    });

    const result = await connector.getValidAccessToken('default');
    expect(result.accessToken).toBe('mock-shopee-token');
    expect(result.shopId).toBe(112233);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('executa lock e rotação segura de refresh token quando o token está expirando', async () => {
    const expiredDate = new Date(Date.now() - 1000);
    const oldCredentials = {
      access_token: 'mock-old-shopee-token',
      refresh_token: 'mock-old-shopee-refresh',
      expire_in: 14400,
      shop_id: 112233,
    };

    mockPrisma.tenantIntegration.findUnique.mockResolvedValue({
      id: 'integ-shopee-1',
      tenantId: 'default',
      provider: 'SHOPEE',
      status: 'ACTIVE',
      expiresAt: expiredDate,
      credentialsEncrypted: encryption.encryptJson(oldCredentials),
    });

    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'integ-shopee-1',
        credentials_encrypted: encryption.encryptJson(oldCredentials),
        expires_at: expiredDate,
        status: 'ACTIVE',
      },
    ]);

    const result = await connector.getValidAccessToken('default');
    expect(result.accessToken).toMatch(/^shopee_rotated_acc_/);
    expect(result.shopId).toBe(112233);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockPrisma.$executeRaw).toHaveBeenCalled();
  });

  it('reutiliza token atualizado caso outra requisição concorrente já tenha renovado durante o lock', async () => {
    const expiredDate = new Date(Date.now() - 1000);
    const oldCredentials = {
      access_token: 'mock-old-shopee-token',
      refresh_token: 'mock-old-shopee-refresh',
      expire_in: 14400,
      shop_id: 112233,
    };

    mockPrisma.tenantIntegration.findUnique.mockResolvedValue({
      id: 'integ-shopee-1',
      tenantId: 'default',
      provider: 'SHOPEE',
      status: 'ACTIVE',
      expiresAt: expiredDate,
      credentialsEncrypted: encryption.encryptJson(oldCredentials),
    });

    const newlyRefreshedDate = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const newlyRefreshedCredentials = {
      access_token: 'mock-token-worker-concurrent',
      refresh_token: 'mock-refresh-concurrent',
      expire_in: 14400,
      shop_id: 112233,
    };

    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'integ-shopee-1',
        credentials_encrypted: encryption.encryptJson(
          newlyRefreshedCredentials,
        ),
        expires_at: newlyRefreshedDate,
        status: 'ACTIVE',
      },
    ]);

    const spyRotation = jest.spyOn(connector, 'executeRefreshTokenRotation');

    const result = await connector.getValidAccessToken('default');
    expect(result.accessToken).toBe('mock-token-worker-concurrent');
    expect(result.shopId).toBe(112233);
    expect(spyRotation).not.toHaveBeenCalled();
  });

  it('obtém pedido em modo simulado', async () => {
    const validUntil = new Date(Date.now() + 60 * 60 * 1000);
    mockPrisma.tenantIntegration.findUnique.mockResolvedValue({
      id: 'integ-shopee-1',
      tenantId: 'default',
      provider: 'SHOPEE',
      status: 'ACTIVE',
      expiresAt: validUntil,
      credentialsEncrypted: encryption.encryptJson({
        access_token: 'mock-shopee-token',
        refresh_token: 'mock-refresh',
        expire_in: 14400,
        shop_id: 112233,
      }),
    });

    const order = await connector.getOrder('230928ABCDEF');
    expect(order.order_sn).toBe('230928ABCDEF');
    expect(order.order_status).toBe('READY_TO_SHIP');
    expect(order.item_list).toHaveLength(1);
    expect(order.buyer.buyer_username).toBe('cliente_shopee_br');
  });

  it('atualiza estoque em modo simulado sem lançar exceções', async () => {
    const validUntil = new Date(Date.now() + 60 * 60 * 1000);
    mockPrisma.tenantIntegration.findUnique.mockResolvedValue({
      id: 'integ-shopee-1',
      tenantId: 'default',
      provider: 'SHOPEE',
      status: 'ACTIVE',
      expiresAt: validUntil,
      credentialsEncrypted: encryption.encryptJson({
        access_token: 'mock-shopee-token',
        refresh_token: 'mock-refresh',
        expire_in: 14400,
        shop_id: 112233,
      }),
    });

    await expect(
      connector.updateStock(991122, 5544, 25, 'default'),
    ).resolves.not.toThrow();
  });

  it('publica item com mapeamento de categoria e variantes em modo simulado', async () => {
    const validUntil = new Date(Date.now() + 60 * 60 * 1000);
    mockPrisma.tenantIntegration.findUnique.mockResolvedValue({
      id: 'integ-shopee-1',
      tenantId: 'default',
      provider: 'SHOPEE',
      status: 'ACTIVE',
      expiresAt: validUntil,
      credentialsEncrypted: encryption.encryptJson({
        access_token: 'mock-shopee-token',
        refresh_token: 'mock-refresh',
        expire_in: 14400,
        shop_id: 112233,
      }),
    });

    const published = await connector.publishItem({
      title: 'Camiseta Básica Oversized',
      priceCents: 15990,
      imageUrls: ['https://example.com/img1.jpg'],
      categoryName: 'Camisetas',
      variations: [
        { variantId: 'var-g', label: 'G', stockQuantity: 20 },
        { variantId: 'var-gg', label: 'GG', stockQuantity: 15 },
      ],
    });

    expect(published.itemId).toBeDefined();
    expect(published.variationMappings).toHaveLength(2);
    expect(published.variationMappings[0].variantId).toBe('var-g');
  });
});
