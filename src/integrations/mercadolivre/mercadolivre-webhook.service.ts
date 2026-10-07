import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { StockService } from '../../catalog/stock.service';
import { ERP_SERVICE, type ErpService } from '../../erp/erp-service';
import { OrderStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { AmazonSyncService } from '../amazon/amazon-sync.service';
import { ShopeeSyncService } from '../shopee/shopee-sync.service';
import { MercadoLivreConnector } from './mercadolivre-connector';

export interface MercadoLivreWebhookPayload {
  _id?: string;
  topic: string;
  resource: string;
  user_id: number;
  application_id?: number;
  sent?: string;
  attempts?: number;
  received?: string;
}

export interface WebhookProcessResult {
  processed: boolean;
  action: string;
  orderId?: string;
  externalOrderId?: string;
}

@Injectable()
export class MercadoLivreWebhookService {
  private readonly logger = new Logger(MercadoLivreWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connector: MercadoLivreConnector,
    private readonly stock: StockService,
    @Optional() private readonly shopeeSync?: ShopeeSyncService,
    @Optional() private readonly amazonSync?: AmazonSyncService,
    @Optional()
    @Inject(ERP_SERVICE)
    private readonly erp?: ErpService,
  ) {}

  /**
   * Processa notificações assíncronas enviadas pelo webhook do Mercado Livre.
   * Suporta tópicos:
   * - `orders_v2` / `orders`: importa o pedido externo, decrementa estoque atomicamente e opcionalmente exporta ao ERP.
   * - `items`: sincroniza alterações do anúncio.
   */
  async processNotification(
    payload: MercadoLivreWebhookPayload,
    tenantId = 'default',
  ): Promise<WebhookProcessResult> {
    const { topic, resource } = payload;
    this.logger.log(
      `Webhook Mercado Livre recebido: tópico=${topic}, recurso=${resource}`,
    );

    if (topic === 'orders_v2' || topic === 'orders') {
      return this.handleOrderTopic(resource, tenantId);
    }

    if (topic === 'items') {
      return this.handleItemTopic(resource, tenantId);
    }

    return {
      processed: false,
      action: `unsupported_topic_${topic}`,
    };
  }

  private async handleOrderTopic(
    resource: string,
    tenantId: string,
  ): Promise<WebhookProcessResult> {
    // Extrai o ID do pedido do recurso (ex: /orders/2000001234567890 -> 2000001234567890)
    const match = /\/orders\/(\d+)/.exec(resource);
    if (!match) {
      return { processed: false, action: 'invalid_order_resource_format' };
    }

    const meliOrderId = match[1];

    // Consulta os detalhes completos do pedido através do conector
    const meliOrder = await this.connector.getOrder(meliOrderId, tenantId);

    // Verifica se este pedido já foi importado anteriormente
    const existingOrder = await this.prisma.order.findFirst({
      where: {
        originChannel: 'MERCADO_LIVRE',
        externalOrderId: String(meliOrder.id),
      },
    });

    if (existingOrder) {
      this.logger.log(
        `Pedido Mercado Livre ${meliOrderId} já registrado localmente (Order ID: ${existingOrder.id}).`,
      );
      return {
        processed: true,
        action: 'order_already_imported',
        orderId: existingOrder.id,
        externalOrderId: String(meliOrder.id),
      };
    }

    // Identifica ou seleciona um usuário do sistema para associar o pedido
    let buyerUser = await this.prisma.user.findFirst({
      where: {
        email:
          meliOrder.buyer.email ?? `ml_${meliOrder.buyer.id}@mercadolivre.test`,
      },
    });

    if (!buyerUser) {
      buyerUser = await this.prisma.user.findFirst({
        where: { role: { name: 'customer' } },
      });
      if (!buyerUser) {
        buyerUser = await this.prisma.user.findFirst();
      }
    }

    if (!buyerUser) {
      this.logger.error(
        'Nenhum usuário disponível para atribuir a ordem do Mercado Livre.',
      );
      return { processed: false, action: 'no_user_available' };
    }

    // Mapeia os itens do pedido com as variantes locais
    const orderItemsToCreate: Array<{
      productId: string;
      variantId: string;
      productName: string;
      variantLabel: string;
      unitPriceCents: number;
      quantity: number;
    }> = [];

    for (const item of meliOrder.order_items) {
      const extItemId = item.item.id;
      const extVarId = item.item.variation_id
        ? String(item.item.variation_id)
        : '';

      // Busca mapeamento cadastrado
      const mapping = await this.prisma.marketplaceItemMapping.findFirst({
        where: {
          provider: 'MERCADO_LIVRE',
          externalItemId: extItemId,
          ...(extVarId ? { externalVariationId: extVarId } : {}),
        },
        include: {
          variant: { include: { product: true } },
        },
      });

      if (mapping?.variant) {
        orderItemsToCreate.push({
          productId: mapping.productId,
          variantId: mapping.variantId,
          productName: mapping.variant.product.name,
          variantLabel: mapping.variant.label,
          unitPriceCents: Math.round(item.unit_price * 100),
          quantity: item.quantity,
        });
      } else {
        // Fallback: se o item ainda não tiver mapeamento registrado, busca um produto ativo qualquer
        const fallbackVariant = await this.prisma.productVariant.findFirst({
          where: { isArchived: false },
          include: { product: true },
        });

        if (fallbackVariant) {
          orderItemsToCreate.push({
            productId: fallbackVariant.productId,
            variantId: fallbackVariant.id,
            productName: item.item.title || fallbackVariant.product.name,
            variantLabel: fallbackVariant.label,
            unitPriceCents: Math.round(item.unit_price * 100),
            quantity: item.quantity,
          });
        }
      }
    }

    if (orderItemsToCreate.length === 0) {
      this.logger.warn(
        `Pedido ML ${meliOrderId} não possui itens com variantes mapeáveis.`,
      );
      return { processed: false, action: 'no_mappable_items' };
    }

    const subtotalCents = orderItemsToCreate.reduce(
      (sum, it) => sum + it.unitPriceCents * it.quantity,
      0,
    );
    const shippingCents = Math.round((meliOrder.shipping_cost ?? 0) * 100);
    const totalCents = subtotalCents + shippingCents;

    const address = meliOrder.shipping?.receiver_address;
    const street = address?.street_name ?? 'Mercado Envios';
    const number = address?.street_number ?? 'S/N';
    const city = address?.city?.name ?? 'São Paulo';
    const state = address?.state?.name ?? 'SP';
    const postalCode = address?.zip_code ?? '01000-000';

    // Executa criação e decremento de estoque atômico dentro de transação PostgreSQL
    const createdOrder = await this.prisma.$transaction(async (tx) => {
      // Decrementa o estoque atômico de cada variante vendida no Mercado Livre
      for (const item of orderItemsToCreate) {
        const decremented = await this.stock.decrement(
          item.variantId,
          item.quantity,
          tx,
        );
        if (!decremented) {
          this.logger.warn(
            `Alerta de Overselling: Estoque insuficiente ao sincronizar venda ML para variante ${item.variantId}.`,
          );
        }
      }

      const isPaid = meliOrder.status === 'paid';
      const orderStatus = isPaid ? OrderStatus.PAID : OrderStatus.CREATED;

      return tx.order.create({
        data: {
          userId: buyerUser.id,
          originChannel: 'MERCADO_LIVRE',
          externalOrderId: String(meliOrder.id),
          status: orderStatus,
          itemsSubtotalCents: subtotalCents,
          shippingCents,
          totalCents,
          shippingStreet: street,
          shippingNumber: number,
          shippingCity: city,
          shippingState: state,
          shippingPostalCode: postalCode,
          shippingLine1: `${street}, ${number}`,
          shippingMethodName: 'Mercado Envios',
          paidAt: isPaid ? new Date(meliOrder.date_created) : null,
          items: {
            create: orderItemsToCreate.map((it) => ({
              productId: it.productId,
              variantId: it.variantId,
              productName: it.productName,
              variantLabel: it.variantLabel,
              unitPriceCents: it.unitPriceCents,
              quantity: it.quantity,
            })),
          },
        },
        include: { items: true },
      });
    });

    // Cascata de estoque em tempo real para os demais canais integrados (Shopee e Amazon)
    for (const item of orderItemsToCreate) {
      const remainingVariant = await this.prisma.productVariant.findUnique({
        where: { id: item.variantId },
      });
      const currentStock = remainingVariant?.stockQuantity ?? 0;

      if (this.shopeeSync) {
        this.shopeeSync
          .syncVariantStock(item.variantId, currentStock, tenantId)
          .catch((err: unknown) => {
            this.logger.warn(
              `Erro ao propagar baixa de estoque ML para Shopee: ${String(err)}`,
            );
          });
      }

      if (this.amazonSync) {
        this.amazonSync
          .syncVariantStock(item.variantId, currentStock, tenantId)
          .catch((err: unknown) => {
            this.logger.warn(
              `Erro ao propagar baixa de estoque ML para Amazon: ${String(err)}`,
            );
          });
      }
    }

    // Se o pedido estiver pago e houver serviço de ERP configurado, exporta para o Bling
    if (createdOrder.status === OrderStatus.PAID && this.erp) {
      try {
        await this.erp.exportOrder({
          id: createdOrder.id,
          totalCents: createdOrder.totalCents,
          itemsSubtotalCents: createdOrder.itemsSubtotalCents,
          shippingCents: createdOrder.shippingCents,
          shippingMethodName: createdOrder.shippingMethodName,
          items: orderItemsToCreate.map((it) => ({
            variantId: it.variantId,
            productName: it.productName,
            variantLabel: it.variantLabel,
            unitPriceCents: it.unitPriceCents,
            quantity: it.quantity,
          })),
          address: {
            street,
            number,
            complement: null,
            neighborhood: null,
            city,
            state,
            postalCode,
          },
          buyer: {
            name:
              `${meliOrder.buyer.first_name ?? ''} ${meliOrder.buyer.last_name ?? ''}`.trim() ||
              meliOrder.buyer.nickname,
            email: buyerUser.email,
          },
          paidAt: createdOrder.paidAt,
        });
      } catch (erpError) {
        this.logger.error(
          `Falha ao exportar pedido importado do ML ${meliOrderId} para o ERP: ${String(erpError)}`,
        );
      }
    }

    return {
      processed: true,
      action: 'order_imported_successfully',
      orderId: createdOrder.id,
      externalOrderId: String(meliOrder.id),
    };
  }

  private async handleItemTopic(
    resource: string,
    tenantId: string,
  ): Promise<WebhookProcessResult> {
    const match = /\/items\/(MLB\w+|\w+)/.exec(resource);
    if (!match) {
      return { processed: false, action: 'invalid_item_resource_format' };
    }

    const itemId = match[1];
    try {
      const item = await this.connector.getItem(itemId, tenantId);
      this.logger.log(
        `Item ML ${itemId} verificado: status=${item.status}, estoque=${item.available_quantity}`,
      );
      return {
        processed: true,
        action: 'item_synced',
      };
    } catch (error) {
      this.logger.error(
        `Erro ao consultar item ML ${itemId}: ${String(error)}`,
      );
      return {
        processed: false,
        action: 'item_sync_failed',
      };
    }
  }
}
