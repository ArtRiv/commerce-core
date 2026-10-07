import { ProductStatus } from '../../generated/prisma/enums';
import { MercadoLivreSyncService } from './mercadolivre-sync.service';

describe('MercadoLivreSyncService', () => {
  let syncService: MercadoLivreSyncService;
  let mockPrisma: any;
  let mockConnector: any;

  beforeEach(() => {
    mockPrisma = {
      marketplaceItemMapping: {
        findMany: jest.fn(),
        upsert: jest.fn().mockResolvedValue({ id: 'mapping-1' }),
      },
      product: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
    };

    mockConnector = {
      updateItemStock: jest.fn().mockResolvedValue(undefined),
      publishItem: jest.fn().mockResolvedValue({
        itemId: 'MLB123456789',
        variationMappings: [
          { variantId: 'var-1', externalVariationId: 'VAR_1' },
          { variantId: 'var-2', externalVariationId: 'VAR_2' },
        ],
      }),
    };

    syncService = new MercadoLivreSyncService(mockPrisma, mockConnector);
  });

  it('sincroniza estoque de variante com o Mercado Livre quando há mapeamento', async () => {
    mockPrisma.marketplaceItemMapping.findMany.mockResolvedValue([
      {
        id: 'map-1',
        externalItemId: 'MLB123',
        externalVariationId: 'VAR_1',
      },
    ]);

    const result = await syncService.syncVariantStock('var-1', 25, 'default');

    expect(result.updatedMappings).toBe(1);
    expect(mockConnector.updateItemStock).toHaveBeenCalledWith(
      'MLB123',
      'VAR_1',
      25,
      'default',
    );
  });

  it('retorna zero se a variante não estiver mapeada no Mercado Livre', async () => {
    mockPrisma.marketplaceItemMapping.findMany.mockResolvedValue([]);

    const result = await syncService.syncVariantStock('var-2', 10, 'default');

    expect(result.updatedMappings).toBe(0);
    expect(mockConnector.updateItemStock).not.toHaveBeenCalled();
  });

  it('sincroniza catálogo de produto e registra mapeamentos no banco', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({
      id: 'prod-1',
      name: 'Camiseta Algodão Egípcio',
      priceCents: 15900,
      imageUrls: ['https://example.com/foto.jpg'],
      status: ProductStatus.ACTIVE,
      variants: [
        { id: 'var-1', label: 'P', stockQuantity: 5, isArchived: false },
        { id: 'var-2', label: 'M', stockQuantity: 12, isArchived: false },
      ],
    });

    const result = await syncService.syncProductCatalog('prod-1', 'default');

    expect(result.externalItemId).toBe('MLB123456789');
    expect(result.mappedVariants).toBe(2);
    expect(mockPrisma.marketplaceItemMapping.upsert).toHaveBeenCalledTimes(2);
  });
});
