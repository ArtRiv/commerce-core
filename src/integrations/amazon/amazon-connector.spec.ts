import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../crypto/encryption.service';
import { AmazonCatalogMappingService } from './amazon-catalog-mapping.service';
import { AmazonConnector } from './amazon-connector';

describe('AmazonConnector', () => {
  let connector: AmazonConnector;
  let prisma: PrismaService;
  let encryption: EncryptionService;

  const mockCreds = {
    access_token: 'Atza|mock-valid-token-123',
    refresh_token: 'Atzr|mock-refresh-token-456',
    selling_partner_id: 'A21TJRUUN4KGV',
    marketplace_id: 'A2Q3Y263D00KWC',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AmazonConnector,
        AmazonCatalogMappingService,
        EncryptionService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
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
              findUnique: jest.fn(),
              update: jest.fn(),
            },
            $transaction: jest.fn(),
          },
        },
      ],
    }).compile();

    connector = module.get<AmazonConnector>(AmazonConnector);
    prisma = module.get<PrismaService>(PrismaService);
    encryption = module.get<EncryptionService>(EncryptionService);
  });

  describe('getValidAccessToken', () => {
    it('deve retornar token em cache quando ainda válido com margem', async () => {
      const encrypted = encryption.encryptJson(mockCreds);
      const validUntil = new Date(Date.now() + 30 * 60 * 1000); // 30 minutos

      jest.spyOn(prisma.tenantIntegration, 'findUnique').mockResolvedValueOnce({
        id: 'ti-amazon-1',
        provider: 'AMAZON',
        credentialsEncrypted: encrypted,
        status: 'ACTIVE',
        expiresAt: validUntil,
      } as any);

      const res = await connector.getValidAccessToken('default');

      expect(res.accessToken).toBe(mockCreds.access_token);
      expect(res.sellingPartnerId).toBe(mockCreds.selling_partner_id);
    });

    it('deve lançar ServiceUnavailableException se integração desconectada', async () => {
      jest
        .spyOn(prisma.tenantIntegration, 'findUnique')
        .mockResolvedValueOnce(null);

      await expect(connector.getValidAccessToken('default')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('deve renovar token sob transação com lock PostgreSQL quando expirado', async () => {
      const encrypted = encryption.encryptJson(mockCreds);
      const expiredAt = new Date(Date.now() - 5 * 60 * 1000); // expirado

      jest.spyOn(prisma.tenantIntegration, 'findUnique').mockResolvedValueOnce({
        id: 'ti-amazon-1',
        provider: 'AMAZON',
        credentialsEncrypted: encrypted,
        status: 'ACTIVE',
        expiresAt: expiredAt,
      } as any);

      jest
        .spyOn(prisma, '$transaction')
        .mockImplementationOnce(async (cb: any) => {
          const txMock = {
            $queryRaw: jest.fn().mockResolvedValueOnce([
              {
                id: 'ti-amazon-1',
                credentials_encrypted: encrypted,
                expires_at: expiredAt,
                status: 'ACTIVE',
              },
            ]),
            tenantIntegration: {
              update: jest.fn().mockResolvedValueOnce({}),
            },
          };
          return cb(txMock);
        });

      const res = await connector.getValidAccessToken('default');
      expect(res.accessToken).toBeDefined();
      expect(res.sellingPartnerId).toBe(mockCreds.selling_partner_id);
    });
  });

  describe('SP-API operations (simulação)', () => {
    beforeEach(() => {
      const encrypted = encryption.encryptJson(mockCreds);
      jest.spyOn(prisma.tenantIntegration, 'findUnique').mockResolvedValue({
        id: 'ti-amazon-1',
        provider: 'AMAZON',
        credentialsEncrypted: encrypted,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      } as any);
    });

    it('deve buscar dados e itens de um pedido na Orders API', async () => {
      const order = await connector.getOrder('701-9988776-1122334', 'default');

      expect(order.AmazonOrderId).toBe('701-9988776-1122334');
      expect(order.OrderStatus).toBe('Unshipped');
      expect(order.BuyerInfo.name).toBeDefined();
      expect(order.ShippingAddress.City).toBe('São Paulo');
      expect(order.OrderItems.length).toBeGreaterThan(0);
    });

    it('deve atualizar estoque de um listing item', async () => {
      const res = await connector.updateListingItem('AVESSO-CAM-OVER-BLK-G', {
        stockQuantity: 12,
      });

      expect(res.success).toBe(true);
      expect(res.sku).toBe('AVESSO-CAM-OVER-BLK-G');
      expect(res.quantity).toBe(12);
    });

    it('deve publicar anúncio com catalogMapping via putListingItem', async () => {
      const res = await connector.putListingItem({
        sku: 'AVESSO-CAM-OVER-BLK-G',
        title: 'Camiseta Oversized Preta',
        variantLabel: 'Preto / G',
        priceCents: 18990,
        stockQuantity: 15,
      });

      expect(res.success).toBe(true);
      expect(res.sku).toBe('AVESSO-CAM-OVER-BLK-G');
    });

    it('deve submeter feed em lote na Feeds API v2021-06-30', async () => {
      const res = await connector.submitFeed('JSON_LISTINGS_FEED', {
        header: { version: '2.0' },
        messages: [],
      });

      expect(res.feedId).toBeDefined();
      expect(res.status).toBe('IN_QUEUE');
      expect(res.feedType).toBe('JSON_LISTINGS_FEED');
    });
  });
});
