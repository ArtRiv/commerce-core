import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../crypto/encryption.service';
import { AmazonAuthService } from './amazon-auth.service';

describe('AmazonAuthService', () => {
  let service: AmazonAuthService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AmazonAuthService,
        EncryptionService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'AMAZON_STATE_SECRET') return 'test-state-secret-123';
              if (key === 'APP_ENCRYPTION_KEY')
                return '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
              return null;
            }),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            tenantIntegration: {
              upsert: jest
                .fn()
                .mockResolvedValue({ id: 'integration-amazon-1' }),
            },
          },
        },
      ],
    }).compile();

    service = module.get<AmazonAuthService>(AmazonAuthService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe('generateState & verifyState', () => {
    it('deve gerar state assinado com HMAC-SHA256 e decodificar com sucesso', () => {
      const state = service.generateState('default');
      expect(state).toBeDefined();

      const verified = service.verifyState(state);
      expect(verified.tenantId).toBe('default');
    });

    it('deve rejeitar state adulterado', () => {
      const state = service.generateState('default');
      const tampered = state.slice(0, -4) + 'abcd';

      expect(() => service.verifyState(tampered)).toThrow(BadRequestException);
    });

    it('deve rejeitar state expirado', () => {
      jest.useFakeTimers();
      const state = service.generateState('default');

      // Avança o tempo além do TTL de 10 minutos
      jest.advanceTimersByTime(11 * 60 * 1000);

      expect(() => service.verifyState(state)).toThrow(BadRequestException);
      jest.useRealTimers();
    });
  });

  describe('getAuthorizationUrl', () => {
    it('deve construir URL do Seller Central com application_id e state assinado', () => {
      const urlStr = service.getAuthorizationUrl('default');
      const url = new URL(urlStr);

      expect(url.hostname).toBe('sellercentral.amazon.com.br');
      expect(url.searchParams.get('application_id')).toBeDefined();
      expect(url.searchParams.get('state')).toBeDefined();
      expect(url.searchParams.get('version')).toBe('beta');
    });
  });

  describe('exchangeAuthorizationCode', () => {
    it('deve trocar código em modo simulado e persistir credenciais cifradas em tenant_integrations', async () => {
      const state = service.generateState('default');

      const result = await service.exchangeAuthorizationCode(
        'mock-spapi-auth-code',
        'A21TJRUUN4KGV',
        state,
      );

      expect(result.tenantId).toBe('default');
      expect(result.sellingPartnerId).toBe('A21TJRUUN4KGV');
      expect(result.marketplaceId).toBe('A2Q3Y263D00KWC');

      expect(prisma.tenantIntegration.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenantId_provider: {
              tenantId: 'default',
              provider: 'AMAZON',
            },
          },
          create: expect.objectContaining({
            provider: 'AMAZON',
            status: 'ACTIVE',
            credentialsEncrypted: expect.stringMatching(
              /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/,
            ),
            metadata: expect.objectContaining({
              sellingPartnerId: 'A21TJRUUN4KGV',
              marketplaceId: 'A2Q3Y263D00KWC',
              dppCompliant: true,
            }),
          }),
        }),
      );
    });
  });
});
