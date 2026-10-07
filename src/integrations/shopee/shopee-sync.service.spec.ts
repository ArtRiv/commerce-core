import { ProductStatus } from '../../generated/prisma/enums';
import { ShopeeSyncService } from './shopee-sync.service';

describe('ShopeeSyncService', () => {
  let syncService: ShopeeSyncService;
  let mockPrisma: any;
  let mockConnector: any;

  beforeEach(() => {
    mockPrisma = {
      marketplaceItemMapping: {
        findMany: jest.fn(),
        upsert: jest.fn().mockResolvedValue({ id: 'mapping-shopee-1' }),
      },
      product: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
    };

    mockConnector = {
      updateStock: jest.fn().mockResolvedValue(undefined),
      publishItem: jest.fn().mockResolvedValue({
        itemId: '88776655',
        variationMappings: [
          { variantId: 'var-1', externalVariationId: '9901' },
          { variantId: 'var-2', externalVariationId: '9902' },
        ],
      }),
    };

    syncService = new ShopeeSyncService(mockPrisma, mockConnector);
  });

  it('sincroniza estoque de variante com a Shopee quando há mapeamento', async () => {
    mockPrisma.marketplaceItemMapping.findMany.mockResolvedValue([
      {
        id: 'map-shopee-1',
        externalItemId: '88776655',
        externalVariationId: '9901',
      },
    ]);

    const result = await syncService.syncVariantStock('var-1', 30, 'default');

    expect(result.updatedMappings).toBe(1);
    expect(mockConnector.updateStock).toHaveBeenCalledWith(
      88776655,
      9901,
      30,
      'default',
    );
  });

  it('retorna zero se a variante não estiver mapeada na Shopee', async () => {
    mockPrisma.marketplaceItemMapping.findMany.mockResolvedValue([]);

    const result = await syncService.syncVariantStock(
      'var-inexistente',
      10,
      'default',
    );

    expect(result.updatedMappings).toBe(0);
    expect(mockConnector.updateStock).not.toHaveBeenCalled();
  });

  it('sincroniza catálogo de produto na Shopee e cadastra mapeamentos de variante', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({
      id: 'prod-shopee-1',
      name: 'Camiseta Algodão Egípcio',
      priceCents: 15900,
      imageUrls: ['https://example.com/foto.jpg'],
      status: ProductStatus.ACTIVE,
      variants: [
        { id: 'var-1', label: 'P', stockQuantity: 5, isArchived: false },
        { id: 'var-2', label: 'M', stockQuantity: 12, isArchived: false },
      ],
      categories: [{ category: { name: 'Camisetas' } }],
    });

    const result = await syncService.syncProductCatalog(
      'prod-shopee-1',
      'default',
    );

    expect(result.externalItemId).toBe('88776655');
    expect(result.mappedVariants).toBe(2);
    expect(mockPrisma.marketplaceItemMapping.upsert).toHaveBeenCalledTimes(2);
  });

  it('sincroniza todos os produtos ativos da loja', async () => {
    mockPrisma.product.findMany.mockResolvedValue([
      { id: 'prod-1' },
      { id: 'prod-2' },
    ]);

    mockPrisma.product.findUnique.mockResolvedValue({
      id: 'prod-1',
      name: 'Camiseta Básica',
      priceCents: 9900,
      imageUrls: [],
      status: ProductStatus.ACTIVE,
      variants: [
        { id: 'var-1', label: 'P', stockQuantity: 10, isArchived: false },
      ],
      categories: [],
    });

    const result = await syncService.syncAllCatalog('default');

    expect(result.syncedProducts).toBe(2);
    expect(result.totalVariants).toBe(4);
  });
});
