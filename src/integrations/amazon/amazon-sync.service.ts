import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { ProductStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { AmazonConnector } from './amazon-connector';

export interface AmazonSyncResult {
  syncedProducts: number;
  totalVariants: number;
}

export interface AmazonProductSyncResult {
  mappedVariants: number;
}

@Injectable()
export class AmazonSyncService {
  private readonly logger = new Logger(AmazonSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connector: AmazonConnector,
  ) {}

  /**
   * Sincroniza em tempo real o saldo de estoque de uma variante na Amazon SP-API.
   * Chamado atomicamente no checkout de pedidos para prevenção rigorosa de overselling.
   */
  async syncVariantStock(
    variantId: string,
    quantity: number,
    tenantId = 'default',
  ): Promise<boolean> {
    try {
      const mappings = await this.prisma.marketplaceItemMapping.findMany({
        where: {
          tenantId,
          provider: 'AMAZON',
          variantId,
        },
      });

      if (mappings.length === 0) {
        // Se a variante ainda não possui mapeamento explícito cadastrado,
        // busca a variante para gerar SKU correspondente
        const variant = await this.prisma.productVariant.findUnique({
          where: { id: variantId },
          include: { product: true },
        });

        if (!variant) {
          return false;
        }

        const fallbackSku = `AVESSO-${variant.product.slug.toUpperCase()}-${variant.label.replace(/\s+/g, '-').toUpperCase()}`;

        await this.connector.updateListingItem(
          fallbackSku,
          { stockQuantity: quantity, priceCents: variant.product.priceCents },
          tenantId,
        );
        return true;
      }

      for (const mapping of mappings) {
        await this.connector.updateListingItem(
          mapping.externalItemId,
          { stockQuantity: quantity },
          tenantId,
        );
      }

      this.logger.log(
        `Estoque sincronizado na Amazon para variante ${variantId}: ${quantity} un.`,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Falha ao sincronizar estoque na Amazon para variante ${variantId}: ${String(error)}`,
      );
      return false;
    }
  }

  /**
   * Sincroniza um produto específico e suas variantes ativas para a Amazon SP-API.
   */
  async syncProductCatalog(
    productId: string,
    tenantId = 'default',
  ): Promise<AmazonProductSyncResult> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: {
        variants: {
          where: { isArchived: false },
        },
        categories: {
          include: { category: true },
        },
      },
    });

    if (!product || product.status !== ProductStatus.ACTIVE) {
      throw new NotFoundException(
        `Produto ${productId} não encontrado ou inativo para publicação na Amazon.`,
      );
    }

    if (product.variants.length === 0) {
      throw new NotFoundException(
        `Produto ${productId} não possui variantes ativas para publicação na Amazon.`,
      );
    }

    const categoryName = product.categories[0]?.category.name ?? null;
    let mappedVariants = 0;

    for (const variant of product.variants) {
      const sku = `AVESSO-${product.slug.toUpperCase()}-${variant.label.replace(/\s+/g, '-').toUpperCase()}`;

      // 1. Cadastra/atualiza mapeamento no banco de dados local
      await this.prisma.marketplaceItemMapping.upsert({
        where: {
          provider_externalItemId_externalVariationId: {
            provider: 'AMAZON',
            externalItemId: sku,
            externalVariationId: variant.id,
          },
        },
        create: {
          tenantId,
          provider: 'AMAZON',
          externalItemId: sku,
          externalVariationId: variant.id,
          productId: product.id,
          variantId: variant.id,
        },
        update: {
          productId: product.id,
          variantId: variant.id,
          updatedAt: new Date(),
        },
      });

      // 2. Publica ou atualiza o anúncio na Listings Items API v2021-08-01
      await this.connector.putListingItem(
        {
          sku,
          title: product.name,
          categoryName,
          description: product.description ?? undefined,
          variantLabel: variant.label,
          priceCents: product.priceCents,
          stockQuantity: variant.stockQuantity,
        },
        tenantId,
      );

      mappedVariants++;
    }

    return { mappedVariants };
  }

  /**
   * Sincroniza em lote todos os produtos ativos do catálogo local para a Amazon SP-API.
   */
  async syncAllCatalog(tenantId = 'default'): Promise<AmazonSyncResult> {
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
          `Falha ao sincronizar produto ${p.id} no catálogo da Amazon: ${String(error)}`,
        );
      }
    }

    this.logger.log(
      `Sincronização de catálogo Amazon concluída: ${syncedProducts} produtos e ${totalVariants} variantes.`,
    );

    return {
      syncedProducts,
      totalVariants,
    };
  }
}
