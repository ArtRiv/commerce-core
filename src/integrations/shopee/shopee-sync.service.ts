import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { ProductStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { ShopeeConnector } from './shopee-connector';

export interface ShopeeCatalogSyncResult {
  syncedProducts: number;
  totalVariants: number;
}

@Injectable()
export class ShopeeSyncService {
  private readonly logger = new Logger(ShopeeSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connector: ShopeeConnector,
  ) {}

  /**
   * Sincroniza atômica e bidirecionalmente a alteração de saldo de estoque de uma variante local
   * para o anúncio/model correspondente na Shopee. Previne riscos de overselling.
   */
  async syncVariantStock(
    variantId: string,
    currentStock: number,
    tenantId = 'default',
  ): Promise<{ updatedMappings: number }> {
    const mappings = await this.prisma.marketplaceItemMapping.findMany({
      where: {
        variantId,
        provider: 'SHOPEE',
        tenantId,
      },
    });

    if (mappings.length === 0) {
      return { updatedMappings: 0 };
    }

    for (const mapping of mappings) {
      try {
        const itemId = Number.parseInt(mapping.externalItemId, 10);
        const modelId = mapping.externalVariationId
          ? Number.parseInt(mapping.externalVariationId, 10)
          : null;

        await this.connector.updateStock(
          itemId,
          modelId,
          currentStock,
          tenantId,
        );
      } catch (error) {
        this.logger.error(
          `Falha ao sincronizar estoque da variante ${variantId} na Shopee (item: ${mapping.externalItemId}): ${String(error)}`,
        );
      }
    }

    return { updatedMappings: mappings.length };
  }

  /**
   * Sincroniza um produto específico e suas variantes ativas para o catálogo da Shopee.
   * Cria ou atualiza os mapeamentos na tabela `marketplace_item_mappings`.
   */
  async syncProductCatalog(
    productId: string,
    tenantId = 'default',
  ): Promise<{ externalItemId: string; mappedVariants: number }> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: {
        variants: {
          where: { isArchived: false },
          orderBy: { position: 'asc' },
        },
        categories: {
          include: { category: true },
        },
      },
    });

    if (!product || product.status !== ProductStatus.ACTIVE) {
      throw new NotFoundException(
        `Produto ${productId} não encontrado ou inativo para publicação na Shopee.`,
      );
    }

    if (product.variants.length === 0) {
      throw new NotFoundException(
        `Produto ${productId} não possui variantes ativas para publicação.`,
      );
    }

    const categoryName = product.categories[0]?.category.name ?? null;

    const published = await this.connector.publishItem(
      {
        title: product.name,
        description: product.description ?? undefined,
        priceCents: product.priceCents,
        imageUrls: product.imageUrls,
        categoryName,
        variations: product.variants.map((v) => ({
          variantId: v.id,
          label: v.label,
          stockQuantity: v.stockQuantity,
        })),
      },
      tenantId,
    );

    for (const mapping of published.variationMappings) {
      await this.prisma.marketplaceItemMapping.upsert({
        where: {
          provider_externalItemId_externalVariationId: {
            provider: 'SHOPEE',
            externalItemId: published.itemId,
            externalVariationId: mapping.externalVariationId,
          },
        },
        create: {
          tenantId,
          provider: 'SHOPEE',
          externalItemId: published.itemId,
          externalVariationId: mapping.externalVariationId,
          productId: product.id,
          variantId: mapping.variantId,
        },
        update: {
          productId: product.id,
          variantId: mapping.variantId,
          updatedAt: new Date(),
        },
      });
    }

    return {
      externalItemId: published.itemId,
      mappedVariants: published.variationMappings.length,
    };
  }

  /**
   * Sincroniza em lote todos os produtos ativos do catálogo local para a Shopee.
   */
  async syncAllCatalog(tenantId = 'default'): Promise<ShopeeCatalogSyncResult> {
    const activeProducts = await this.prisma.product.findMany({
      where: { status: ProductStatus.ACTIVE },
      select: { id: true },
    });

    let totalVariants = 0;
    let syncedProducts = 0;

    for (const p of activeProducts) {
      try {
        const result = await this.syncProductCatalog(p.id, tenantId);
        syncedProducts++;
        totalVariants += result.mappedVariants;
      } catch (error) {
        this.logger.error(
          `Falha ao sincronizar produto ${p.id} no catálogo da Shopee: ${String(error)}`,
        );
      }
    }

    return {
      syncedProducts,
      totalVariants,
    };
  }
}
