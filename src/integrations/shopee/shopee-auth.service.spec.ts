import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EncryptionService } from '../crypto/encryption.service';
import { ShopeeAuthService } from './shopee-auth.service';

describe('ShopeeAuthService', () => {
  let authService: ShopeeAuthService;
  let encryptionService: EncryptionService;
  let mockPrisma: any;

  beforeEach(() => {
    const config = new ConfigService({
      NODE_ENV: 'test',
      SHOPEE_STATE_SECRET: 'shopee-secret-32-chars-long-12345678',
      APP_ENCRYPTION_KEY: 'e'.repeat(64),
      SHOPEE_PARTNER_ID: '123456',
      SHOPEE_PARTNER_KEY: 'partner-key-xyz',
      API_URL: 'http://localhost:3000',
    });

    encryptionService = new EncryptionService(config);

    mockPrisma = {
      tenantIntegration: {
        upsert: jest.fn().mockResolvedValue({ id: 'integ-shopee-1' }),
      },
    };

    authService = new ShopeeAuthService(config, mockPrisma, encryptionService);
  });

  it('gera state assinado com HMAC-SHA256 e valida com sucesso', () => {
    const state = authService.generateState('tenant-shopee-1');
    expect(state).toBeDefined();

    const verified = authService.verifyState(state);
    expect(verified).toEqual({ tenantId: 'tenant-shopee-1' });
  });

  it('rejeita state com assinatura adulterada', () => {
    const state = authService.generateState('tenant-shopee-1');
    const decoded = JSON.parse(
      Buffer.from(state, 'base64url').toString('utf8'),
    );

    decoded.tenantId = 'tenant-invasor';
    const tampered = Buffer.from(JSON.stringify(decoded)).toString('base64url');

    expect(() => authService.verifyState(tampered)).toThrow(
      BadRequestException,
    );
  });

  it('rejeita state expirado (> 10 minutos)', () => {
    const state = authService.generateState('tenant-shopee-1');
    const decoded = JSON.parse(
      Buffer.from(state, 'base64url').toString('utf8'),
    );

    decoded.timestamp = Date.now() - 15 * 60 * 1000;
    const expired = Buffer.from(JSON.stringify(decoded)).toString('base64url');

    expect(() => authService.verifyState(expired)).toThrow(BadRequestException);
  });

  it('gera assinatura pública HMAC-SHA256 corretamente', () => {
    const path = '/api/v2/shop/auth_partner';
    const timestamp = 1696600000;
    const signature = authService.generatePublicSignature(path, timestamp);

    expect(signature).toBeDefined();
    expect(typeof signature).toBe('string');
    expect(signature.length).toBe(64); // SHA256 hex é 64 caracteres
  });

  it('gera URL de autorização da Shopee com parâmetros oficiais (/api/v2/shop/auth_partner)', () => {
    const authUrl = authService.getAuthorizationUrl('default');
    const parsed = new URL(authUrl);

    expect(parsed.hostname).toBe('partner.shopeemobile.com');
    expect(parsed.pathname).toBe('/api/v2/shop/auth_partner');
    expect(parsed.searchParams.get('partner_id')).toBe('123456');
    expect(parsed.searchParams.get('timestamp')).toBeDefined();
    expect(parsed.searchParams.get('sign')).toBeDefined();
    expect(parsed.searchParams.get('redirect')).toContain('state=');
  });

  it('troca código de autorização e persiste credenciais encriptadas', async () => {
    const devConfig = new ConfigService({
      NODE_ENV: 'test',
      SHOPEE_STATE_SECRET: 'shopee-secret-32-chars-long-12345678',
      APP_ENCRYPTION_KEY: 'e'.repeat(64),
      SHOPEE_PARTNER_ID: '', // Simulado
      SHOPEE_PARTNER_KEY: '',
    });

    const devAuthService = new ShopeeAuthService(
      devConfig,
      mockPrisma,
      encryptionService,
    );

    const state = devAuthService.generateState('tenant-shopee');
    const result = await devAuthService.exchangeAuthorizationCode(
      'code-shopee-123',
      987654,
      state,
    );

    expect(result.tenantId).toBe('tenant-shopee');
    expect(result.shopId).toBe(987654);
    expect(result.shopName).toBe('Loja Oficial Shopee');
    expect(mockPrisma.tenantIntegration.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_provider: {
            tenantId: 'tenant-shopee',
            provider: 'SHOPEE',
          },
        },
        create: expect.objectContaining({
          status: 'ACTIVE',
        }),
      }),
    );
  });
});
