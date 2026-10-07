import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EncryptionService } from '../crypto/encryption.service';
import { MercadoLivreAuthService } from './mercadolivre-auth.service';

describe('MercadoLivreAuthService', () => {
  let authService: MercadoLivreAuthService;
  let encryptionService: EncryptionService;
  let mockPrisma: any;

  beforeEach(() => {
    const config = new ConfigService({
      NODE_ENV: 'test',
      MERCADO_LIVRE_STATE_SECRET: 'test-secret-32-chars-long-12345678',
      APP_ENCRYPTION_KEY: 'e'.repeat(64),
      MERCADO_LIVRE_CLIENT_ID: '123456',
      MERCADO_LIVRE_CLIENT_SECRET: 'secret-xyz',
      API_URL: 'http://localhost:3000',
    });

    encryptionService = new EncryptionService(config);

    mockPrisma = {
      tenantIntegration: {
        upsert: jest.fn().mockResolvedValue({ id: 'integ-1' }),
      },
    };

    authService = new MercadoLivreAuthService(
      config,
      mockPrisma,
      encryptionService,
    );
  });

  it('gera state assinado com HMAC-SHA256 e valida com sucesso', () => {
    const state = authService.generateState('tenant-loja-1');
    expect(state).toBeDefined();

    const verified = authService.verifyState(state);
    expect(verified).toEqual({ tenantId: 'tenant-loja-1' });
  });

  it('rejeita state com assinatura adulterada', () => {
    const state = authService.generateState('tenant-loja-1');
    const decoded = JSON.parse(
      Buffer.from(state, 'base64url').toString('utf8'),
    );

    // Altera o tenantId mantendo a assinatura original
    decoded.tenantId = 'tenant-invasor';
    const tampered = Buffer.from(JSON.stringify(decoded)).toString('base64url');

    expect(() => authService.verifyState(tampered)).toThrow(
      BadRequestException,
    );
  });

  it('rejeita state expirado (> 10 minutos)', () => {
    const state = authService.generateState('tenant-loja-1');
    const decoded = JSON.parse(
      Buffer.from(state, 'base64url').toString('utf8'),
    );

    // Força timestamp de 15 minutos atrás
    decoded.timestamp = Date.now() - 15 * 60 * 1000;
    const expired = Buffer.from(JSON.stringify(decoded)).toString('base64url');

    expect(() => authService.verifyState(expired)).toThrow(BadRequestException);
  });

  it('gera URL de autorização com parâmetros corretos', () => {
    const authUrl = authService.getAuthorizationUrl('default');
    const parsed = new URL(authUrl);

    expect(parsed.hostname).toBe('auth.mercadolivre.com.br');
    expect(parsed.pathname).toBe('/authorization');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('123456');
    expect(parsed.searchParams.get('state')).toBeDefined();
  });

  it('troca código de autorização e persiste credenciais encriptadas', async () => {
    // Configura em modo simulado
    const devConfig = new ConfigService({
      NODE_ENV: 'test',
      MERCADO_LIVRE_STATE_SECRET: 'test-secret-32-chars-long-12345678',
      APP_ENCRYPTION_KEY: 'e'.repeat(64),
      MERCADO_LIVRE_CLIENT_ID: '', // vazio -> simulado
      MERCADO_LIVRE_CLIENT_SECRET: '',
    });

    const devAuthService = new MercadoLivreAuthService(
      devConfig,
      mockPrisma,
      encryptionService,
    );

    const state = devAuthService.generateState('tenant-demo');
    const result = await devAuthService.exchangeAuthorizationCode(
      'code-123',
      state,
    );

    expect(result.tenantId).toBe('tenant-demo');
    expect(result.nickname).toBe('LOJA_DEMO_ML');
    expect(mockPrisma.tenantIntegration.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_provider: {
            tenantId: 'tenant-demo',
            provider: 'MERCADO_LIVRE',
          },
        },
        create: expect.objectContaining({
          status: 'ACTIVE',
        }),
      }),
    );
  });
});
