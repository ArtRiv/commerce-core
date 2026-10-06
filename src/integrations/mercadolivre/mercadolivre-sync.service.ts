import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { ProductStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { MercadoLivreConnector } from './mercadolivre-connector';

export interface CatalogSyncResult {
  syncedProducts: number;
  totalVariants: number;
}

@Injectable()
export class MercadoLivreSyncService {
  private readonly logger = new Logger(MercadoLivreSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connector: MercadoLivreConnector,
  ) {}

  /**
   * Sincroniza a alteração de saldo de uma variante local para o anúncio correspondente no Mercado Livre.
   *
   * Garante a prevenção de overselling: assim que uma unidade é vendida ou atualizada na loja própria,
   * o novo saldo é imediatamente refletido no marketplace.
   */
  async syncVariantStock(
    variantId: string,
    currentStock: number,
    tenantId = 'default',
  ): Promise<{ updatedMappings: number }> {
    const mappings = await this.prisma.marketplaceItemMapping.findMany({
      where: {
        variantId,
        provider: 'MERCADO_LIVRE',
        tenantId,
      },
    });

    if (mappings.length === 0) {
      return { updatedMappings: 0 };
    }

    for (const mapping of mappings) {
      try {
        await this.connector.updateItemStock(
          mapping.externalItemId,
          mapping.externalVariationId || null,
          currentStock,
          tenantId,
        );
      } catch (error) {
        this.logger.error(
          `Falha ao sincronizar estoque da variante ${variantId} no item ML ${mapping.externalItemId}: ${String(error)}`,
        );
      }
    }

    return { updatedMappings: mappings.length };
  }

  /**
   * Sincroniza um produto específico e suas variantes para o catálogo do Mercado Livre.
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
      },
    });

    if (!product || product.status !== ProductStatus.ACTIVE) {
      throw new NotFoundException(
        `Produto ${productId} não encontrado ou inativo para publicação no Mercado Livre.`,
      );
    }

    if (product.variants.length === 0) {
      throw new NotFoundException(
        `Produto ${productId} não possui variantes ativas para publicação.`,
      );
    }

    const published = await this.connector.publishItem(
      {
        title: product.name,
        description: product.description ?? undefined,
        priceCents: product.priceCents,
        imageUrls: product.imageUrls,
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
            provider: 'MERCADO_LIVRE',
            externalItemId: published.itemId,
            externalVariationId: mapping.externalVariationId,
          },
        },
        create: {
          tenantId,
          provider: 'MERCADO_LIVRE',
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
   * Sincroniza todos os produtos ativos da loja com o Mercado Livre.
   */
  async syncAllCatalog(tenantId = 'default'): Promise<CatalogSyncResult> {
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
          `Falha ao sincronizar produto ${p.id} no catálogo do Mercado Livre: ${String(error)}`,
        );
      }
    }

    return {
      syncedProducts,
      totalVariants,
    };
  }
}
