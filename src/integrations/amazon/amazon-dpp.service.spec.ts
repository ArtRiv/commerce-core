import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../crypto/encryption.service';
import { type AmazonBuyerPii, AmazonDppService } from './amazon-dpp.service';

describe('AmazonDppService', () => {
  let service: AmazonDppService;
  let prisma: PrismaService;

  const mockBuyerPii: AmazonBuyerPii = {
    buyerName: 'Arthur Silveira',
    buyerEmail: 'arthur.buyer@marketplace.amazon.com',
    phone: '+5511999998888',
    cpfCnpj: '123.456.789-10',
    shippingAddress: {
      recipientName: 'Arthur Silveira',
      addressLine1: 'Rua Augusta, 500',
      addressLine2: 'Apto 42',
      street: 'Rua Augusta',
      number: '500',
      city: 'São Paulo',
      state: 'SP',
      postalCode: '01305-000',
      countryCode: 'BR',
    },
  };

  const mockOrder = {
    id: 'ord-amazon-dpp-1',
    originChannel: 'AMAZON',
    externalOrderId: '701-1234567-1234567',
    encryptedBuyerPii: 'encrypted-pii-payload',
    shippingLine1: 'Rua Augusta, 500',
    shippingNumber: '500',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AmazonDppService,
        EncryptionService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'APP_ENCRYPTION_KEY') {
                return '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
              }
              return null;
            }),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            order: {
              findUnique: jest.fn().mockResolvedValue(mockOrder),
              update: jest
                .fn()
                .mockResolvedValue({ ...mockOrder, encryptedBuyerPii: null }),
            },
            tenantIntegration: {
              findUnique: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<AmazonDppService>(AmazonDppService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  it('deve criptografar e decriptografar PII com segurança e integridade (AES-256-GCM)', () => {
    const encrypted = service.encryptBuyerPii(mockBuyerPii);
    expect(encrypted).toBeDefined();
    expect(encrypted).not.toContain(mockBuyerPii.buyerName);
    expect(encrypted.split(':')).toHaveLength(3); // iv:tag:ciphertext

    const decrypted = service.decryptBuyerPii(encrypted);
    expect(decrypted).toEqual(mockBuyerPii);
    expect(decrypted.shippingAddress.addressLine1).toBe('Rua Augusta, 500');
  });

  it('deve anonimizar dados PII de pedidos da Amazon conforme retenção da DPP', async () => {
    const success = await service.anonymizeOrderPii('ord-amazon-dpp-1');

    expect(success).toBe(true);
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'ord-amazon-dpp-1' },
      data: expect.objectContaining({
        encryptedBuyerPii: null,
        shippingLine1: '[AMAZON-PII-PURGED-DPP]',
        shippingStreet: '[PURGED]',
      }),
    });
  });

  it('deve recusar anonimização de pedidos de canais não-Amazon', async () => {
    jest.spyOn(prisma.order, 'findUnique').mockResolvedValueOnce({
      ...mockOrder,
      originChannel: 'STOREFRONT',
    } as any);

    const success = await service.anonymizeOrderPii('ord-other-1');
    expect(success).toBe(false);
  });

  it('deve avaliar status de conformidade da regra de 180 dias de rotação de credenciais', async () => {
    // Caso 1: Conectado há 10 dias -> COMPLIANT
    jest.spyOn(prisma.tenantIntegration, 'findUnique').mockResolvedValueOnce({
      id: 'ti-1',
      status: 'ACTIVE',
      updatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
    } as any);

    const report1 = await service.checkComplianceStatus('default');
    expect(report1.compliant).toBe(true);
    expect(report1.dppAuditStatus).toBe('COMPLIANT');

    // Caso 2: Conectado há 190 dias -> ROTATION_REQUIRED
    jest.spyOn(prisma.tenantIntegration, 'findUnique').mockResolvedValueOnce({
      id: 'ti-2',
      status: 'ACTIVE',
      updatedAt: new Date(Date.now() - 190 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
    } as any);

    const report2 = await service.checkComplianceStatus('default');
    expect(report2.compliant).toBe(false);
    expect(report2.dppAuditStatus).toBe('ROTATION_REQUIRED');
  });
});
