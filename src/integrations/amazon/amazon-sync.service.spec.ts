import { Test, TestingModule } from '@nestjs/testing';

import { ProductStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { AmazonConnector } from './amazon-connector';
import { AmazonSyncService } from './amazon-sync.service';

describe('AmazonSyncService', () => {
  let service: AmazonSyncService;
  let prisma: PrismaService;
  let connector: AmazonConnector;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AmazonSyncService,
        {
          provide: PrismaService,
          useValue: {
            marketplaceItemMapping: {
              findMany: jest.fn(),
              upsert: jest.fn(),
            },
            productVariant: {
              findUnique: jest.fn(),
            },
            product: {
              findMany: jest.fn(),
              findUnique: jest.fn(),
            },
          },
        },
        {
          provide: AmazonConnector,
          useValue: {
            updateListingItem: jest
              .fn()
              .mockResolvedValue({ success: true, sku: 'SKU1', quantity: 10 }),
            putListingItem: jest
              .fn()
              .mockResolvedValue({ success: true, sku: 'SKU1' }),
          },
        },
      ],
    }).compile();

    service = module.get<AmazonSyncService>(AmazonSyncService);
    prisma = module.get<PrismaService>(PrismaService);
    connector = module.get<AmazonConnector>(AmazonConnector);
  });

  describe('syncVariantStock', () => {
    it('deve atualizar estoque quando houver mapeamento registrado', async () => {
      jest
        .spyOn(prisma.marketplaceItemMapping, 'findMany')
        .mockResolvedValueOnce([
          {
            id: 'map-1',
            provider: 'AMAZON',
            externalItemId: 'AVESSO-CAM-OVER-BLK-G',
            variantId: 'var-1',
          } as any,
        ]);

      const success = await service.syncVariantStock('var-1', 7, 'default');

      expect(success).toBe(true);
      expect(connector.updateListingItem).toHaveBeenCalledWith(
        'AVESSO-CAM-OVER-BLK-G',
        { stockQuantity: 7 },
        'default',
      );
    });

    it('deve usar fallback de SKU quando mapeamento explícito não existir', async () => {
      jest
        .spyOn(prisma.marketplaceItemMapping, 'findMany')
        .mockResolvedValueOnce([]);
      jest.spyOn(prisma.productVariant, 'findUnique').mockResolvedValueOnce({
        id: 'var-uuid-999',
        label: 'M',
        product: { slug: 'camiseta-silk', priceCents: 15990 },
      } as any);

      const success = await service.syncVariantStock(
        'var-uuid-999',
        5,
        'default',
      );

      expect(success).toBe(true);
      expect(connector.updateListingItem).toHaveBeenCalledWith(
        'AVESSO-CAMISETA-SILK-M',
        { stockQuantity: 5, priceCents: 15990 },
        'default',
      );
    });
  });

  describe('syncAllCatalog', () => {
    it('deve varrer produtos ativos e sincronizar variantes', async () => {
      jest
        .spyOn(prisma.product, 'findMany')
        .mockResolvedValueOnce([{ id: 'prod-1' } as any]);

      jest.spyOn(prisma.product, 'findUnique').mockResolvedValueOnce({
        id: 'prod-1',
        name: 'Camiseta Oversized',
        slug: 'camiseta-oversized',
        status: ProductStatus.ACTIVE,
        priceCents: 18990,
        categories: [{ category: { name: 'Camisetas' } }],
        variants: [
          {
            id: 'var-1',
            label: 'P',
            stockQuantity: 10,
          },
          {
            id: 'var-2',
            label: 'M',
            stockQuantity: 15,
          },
        ],
      } as any);

      const res = await service.syncAllCatalog('default');

      expect(res.syncedProducts).toBe(1);
      expect(res.totalVariants).toBe(2);
      expect(prisma.marketplaceItemMapping.upsert).toHaveBeenCalledTimes(2);
      expect(connector.putListingItem).toHaveBeenCalledTimes(2);
    });
  });
});
