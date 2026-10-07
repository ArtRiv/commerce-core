import { ConfigService } from '@nestjs/config';

import { EncryptionService } from '../crypto/encryption.service';
import { MercadoLivreConnector } from './mercadolivre-connector';

describe('MercadoLivreConnector', () => {
  let connector: MercadoLivreConnector;
  let encryption: EncryptionService;
  let mockPrisma: any;

  beforeEach(() => {
    const config = new ConfigService({
      NODE_ENV: 'test',
      APP_ENCRYPTION_KEY: 'f'.repeat(64),
      MERCADO_LIVRE_CLIENT_ID: '', // Simulado
      MERCADO_LIVRE_CLIENT_SECRET: '',
    });

    encryption = new EncryptionService(config);

    mockPrisma = {
      tenantIntegration: {
        findUnique: jest.fn(),
      },
      $transaction: jest.fn((callback) => callback(mockPrisma)),
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn(),
    };

    connector = new MercadoLivreConnector(config, mockPrisma, encryption);
  });

  it('retorna access_token existente se ainda estiver válido e distante da expiração', async () => {
    const validUntil = new Date(Date.now() + 60 * 60 * 1000); // 1 hora no futuro
    const credentials = {
      access_token: 'mock-valid-token',
      refresh_token: 'mock-refresh-1',
    };

    mockPrisma.tenantIntegration.findUnique.mockResolvedValue({
      id: 'integ-1',
      tenantId: 'default',
      provider: 'MERCADO_LIVRE',
      status: 'ACTIVE',
      expiresAt: validUntil,
      credentialsEncrypted: encryption.encryptJson(credentials),
    });

    const token = await connector.getValidAccessToken('default');
    expect(token).toBe('mock-valid-token');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('executa lock e rotação segura de refresh token quando o token está expirando', async () => {
    const expiredDate = new Date(Date.now() - 1000); // Expirado
    const oldCredentials = {
      access_token: 'mock-old-token',
      refresh_token: 'mock-refresh-antigo',
    };

    mockPrisma.tenantIntegration.findUnique.mockResolvedValue({
      id: 'integ-1',
      tenantId: 'default',
      provider: 'MERCADO_LIVRE',
      status: 'ACTIVE',
      expiresAt: expiredDate,
      credentialsEncrypted: encryption.encryptJson(oldCredentials),
    });

    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'integ-1',
        credentials_encrypted: encryption.encryptJson(oldCredentials),
        expires_at: expiredDate,
        status: 'ACTIVE',
      },
    ]);

    const token = await connector.getValidAccessToken('default');
    expect(token).toMatch(/^APP_USR-rotated-/);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockPrisma.$executeRaw).toHaveBeenCalled();
  });

  it('reutiliza token atualizado caso outra requisição concorrente já tenha renovado durante o lock', async () => {
    const expiredDate = new Date(Date.now() - 1000);
    const oldCredentials = {
      access_token: 'mock-old-token',
      refresh_token: 'mock-refresh-antigo',
    };

    mockPrisma.tenantIntegration.findUnique.mockResolvedValue({
      id: 'integ-1',
      tenantId: 'default',
      provider: 'MERCADO_LIVRE',
      status: 'ACTIVE',
      expiresAt: expiredDate,
      credentialsEncrypted: encryption.encryptJson(oldCredentials),
    });

    // Simula que após adquirir o lock, a linha no banco já contém o token renovado por outro worker!
    const newlyRefreshedDate = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const newlyRefreshedCredentials = {
      access_token: 'mock-token-worker-1',
      refresh_token: 'mock-refresh-novo',
    };

    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'integ-1',
        credentials_encrypted: encryption.encryptJson(
          newlyRefreshedCredentials,
        ),
        expires_at: newlyRefreshedDate,
        status: 'ACTIVE',
      },
    ]);

    const spyRotation = jest.spyOn(connector, 'executeRefreshTokenRotation');

    const token = await connector.getValidAccessToken('default');

    expect(token).toBe('mock-token-worker-1');
    // Não deve disparar nova rotação externa contra o Mercado Livre!
    expect(spyRotation).not.toHaveBeenCalled();
  });

  it('obtém pedido em modo simulado', async () => {
    const validUntil = new Date(Date.now() + 60 * 60 * 1000);
    mockPrisma.tenantIntegration.findUnique.mockResolvedValue({
      id: 'integ-1',
      tenantId: 'default',
      provider: 'MERCADO_LIVRE',
      status: 'ACTIVE',
      expiresAt: validUntil,
      credentialsEncrypted: encryption.encryptJson({
        access_token: 'mock-token',
        refresh_token: 'mock-refresh',
      }),
    });

    const order = await connector.getOrder('200000123');
    expect(order.id).toBeDefined();
    expect(order.order_items).toHaveLength(1);
    expect(order.buyer.nickname).toBe('COMPRADOR_ML');
  });

  it('publica item gerando IDs e mapeamentos de variante em modo simulado', async () => {
    const validUntil = new Date(Date.now() + 60 * 60 * 1000);
    mockPrisma.tenantIntegration.findUnique.mockResolvedValue({
      id: 'integ-1',
      tenantId: 'default',
      provider: 'MERCADO_LIVRE',
      status: 'ACTIVE',
      expiresAt: validUntil,
      credentialsEncrypted: encryption.encryptJson({
        access_token: 'mock-token',
        refresh_token: 'mock-refresh',
      }),
    });

    const published = await connector.publishItem({
      title: 'Camiseta Silk',
      priceCents: 9900,
      imageUrls: ['https://example.com/img.jpg'],
      variations: [
        { variantId: 'var-1', label: 'P', stockQuantity: 10 },
        { variantId: 'var-2', label: 'M', stockQuantity: 15 },
      ],
    });

    expect(published.itemId).toMatch(/^MLB/);
    expect(published.variationMappings).toHaveLength(2);
    expect(published.variationMappings[0].variantId).toBe('var-1');
  });
});
