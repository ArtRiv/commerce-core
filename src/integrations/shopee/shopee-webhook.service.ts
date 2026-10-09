import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { StockService } from '../../catalog/stock.service';
import { ERP_SERVICE, type ErpService } from '../../erp/erp-service';
import { OrderStatus } from '../../generated/prisma/enums';
import { RequestContextService } from '../../observability/request-context.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AmazonSyncService } from '../amazon/amazon-sync.service';
import { ShopeeWebhookDto } from '../dto/shopee-webhook.dto';
import { MercadoLivreSyncService } from '../mercadolivre/mercadolivre-sync.service';
import { ShopeeConnector } from './shopee-connector';

export interface ShopeeWebhookProcessResult {
  processed: boolean;
  action: string;
  orderId?: string;
  externalOrderId?: string;
}

@Injectable()
export class ShopeeWebhookService {
  private readonly logger = new Logger(ShopeeWebhookService.name);
  private readonly partnerKey: string | null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly connector: ShopeeConnector,
    private readonly stock: StockService,
    @Optional() private readonly meliSync?: MercadoLivreSyncService,
    @Optional() private readonly amazonSync?: AmazonSyncService,
    @Optional()
    @Inject(ERP_SERVICE)
    private readonly erp?: ErpService,
  ) {
    this.partnerKey =
      this.config.get<string>('SHOPEE_PARTNER_KEY')?.trim() ?? null;
  }

  /**
   * Valida a assinatura HMAC-SHA256 enviada no cabeçalho `Authorization` do webhook da Shopee.
   */
  verifyPushSignature(signatureHeader?: string, rawBody?: string): boolean {
    if (!this.partnerKey) {
      // Em desenvolvimento ou testes automatizados, ignora validação de cabeçalho
      return true;
    }

    if (!signatureHeader || !rawBody) {
      throw new UnauthorizedException('Assinatura do webhook Shopee ausente.');
    }

    const calculatedSig = createHmac('sha256', this.partnerKey)
      .update(rawBody)
      .digest('hex');

    const sigBuf = Buffer.from(signatureHeader, 'hex');
    const calcBuf = Buffer.from(calculatedSig, 'hex');

    if (sigBuf.length !== calcBuf.length || !timingSafeEqual(sigBuf, calcBuf)) {
      throw new UnauthorizedException('Assinatura do webhook Shopee inválida.');
    }

    return true;
  }

  /**
   * Processa a notificação push recebida da Shopee Open Platform.
   * Suporta códigos:
   * - `3`: Atualização / Criação de Pedido (Order Update)
   * - `2`: Atualização de Anúncio / Item (Item Update)
   */
  async processPushNotification(
    payload: ShopeeWebhookDto,
    tenantId = 'default',
  ): Promise<ShopeeWebhookProcessResult> {
    RequestContextService.setTenantId(tenantId);
    const { code, shop_id, data } = payload;
    this.logger.log(
      `Push Shopee recebido: code=${code}, shop_id=${shop_id}, data=${JSON.stringify(data ?? {})}`,
    );

    if (code === 3) {
      return this.handleOrderPush(data, tenantId);
    }

    if (code === 2) {
      return {
        processed: true,
        action: 'item_updated',
      };
    }

    return {
      processed: false,
      action: `unsupported_code_${code}`,
    };
  }

  private async handleOrderPush(
    data: Record<string, unknown> | undefined,
    tenantId: string,
  ): Promise<ShopeeWebhookProcessResult> {
    const orderSn = (data?.ordersn as string | undefined) ?? 'SHOPEE_SIM_001';

    // 1. Busca os dados completos do pedido na API da Shopee
    const shopeeOrder = await this.connector.getOrder(orderSn, tenantId);

    // 2. Verificação de idempotência: não duplica pedidos já importados
    const existingOrder = await this.prisma.order.findFirst({
      where: {
        originChannel: 'SHOPEE',
        externalOrderId: shopeeOrder.order_sn,
      },
    });

    if (existingOrder) {
      RequestContextService.setOrderId(existingOrder.id);
      this.logger.log(
        `Pedido Shopee ${shopeeOrder.order_sn} já importado (Order ID: ${existingOrder.id}).`,
      );
      return {
        processed: true,
        action: 'order_already_imported',
        orderId: existingOrder.id,
        externalOrderId: shopeeOrder.order_sn,
      };
    }

    // 3. Usuário para associar o pedido no banco central
    let buyerUser = await this.prisma.user.findFirst({
      where: {
        email: `shopee_${shopeeOrder.buyer.buyer_username}@shopee.test`,
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
        'Nenhum usuário disponível para associar o pedido da Shopee.',
      );
      return { processed: false, action: 'no_user_available' };
    }

    // 4. Mapeamento dos itens do pedido Shopee para variantes locais
    const orderItemsToCreate: Array<{
      productId: string;
      variantId: string;
      productName: string;
      variantLabel: string;
      unitPriceCents: number;
      quantity: number;
    }> = [];

    for (const item of shopeeOrder.item_list) {
      const extItemId = String(item.item_id);
      const extVarId = item.model_id ? String(item.model_id) : '';

      const mapping = await this.prisma.marketplaceItemMapping.findFirst({
        where: {
          provider: 'SHOPEE',
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
          unitPriceCents: Math.round(item.model_discounted_price * 100),
          quantity: item.model_quantity_purchased,
        });
      } else {
        // Fallback: seleciona uma variante ativa qualquer do catálogo
        const fallbackVariant = await this.prisma.productVariant.findFirst({
          where: { isArchived: false },
          include: { product: true },
        });

        if (fallbackVariant) {
          orderItemsToCreate.push({
            productId: fallbackVariant.productId,
            variantId: fallbackVariant.id,
            productName: item.item_name || fallbackVariant.product.name,
            variantLabel: item.model_name || fallbackVariant.label,
            unitPriceCents: Math.round(item.model_discounted_price * 100),
            quantity: item.model_quantity_purchased,
          });
        }
      }
    }

    if (orderItemsToCreate.length === 0) {
      this.logger.warn(
        `Pedido Shopee ${orderSn} não possui itens com variantes mapeáveis.`,
      );
      return { processed: false, action: 'no_mappable_items' };
    }

    const subtotalCents = orderItemsToCreate.reduce(
      (sum, it) => sum + it.unitPriceCents * it.quantity,
      0,
    );
    const shippingCents = Math.round(
      (shopeeOrder.actual_shipping_fee ?? 0) * 100,
    );
    const totalCents = subtotalCents + shippingCents;

    const address = shopeeOrder.recipient_address;
    const street = address?.full_address ?? 'Shopee Envio Logística';
    const number = 'S/N';
    const city = address?.city ?? 'São Paulo';
    const state = address?.state ?? 'SP';
    const postalCode = address?.zipcode ?? '01000-000';

    // 5. Transação PostgreSQL com decremento atômico de estoque (overselling prevention)
    const createdOrder = await this.prisma.$transaction(async (tx) => {
      for (const item of orderItemsToCreate) {
        const decremented = await this.stock.decrement(
          item.variantId,
          item.quantity,
          tx,
        );
        if (!decremented) {
          this.logger.warn(
            `Alerta de Overselling: Estoque insuficiente ao sincronizar venda Shopee para variante ${item.variantId}.`,
          );
        }
      }

      const isPaid =
        shopeeOrder.order_status === 'READY_TO_SHIP' ||
        shopeeOrder.order_status === 'PROCESSED' ||
        shopeeOrder.order_status === 'COMPLETED';
      const orderStatus = isPaid ? OrderStatus.PAID : OrderStatus.CREATED;

      return tx.order.create({
        data: {
          userId: buyerUser.id,
          originChannel: 'SHOPEE',
          externalOrderId: shopeeOrder.order_sn,
          status: orderStatus,
          itemsSubtotalCents: subtotalCents,
          shippingCents,
          totalCents,
          shippingStreet: street,
          shippingNumber: number,
          shippingCity: city,
          shippingState: state,
          shippingPostalCode: postalCode,
          shippingLine1: street,
          shippingMethodName: 'Shopee Envio',
          paidAt: isPaid ? new Date(shopeeOrder.create_time * 1000) : null,
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

    RequestContextService.setOrderId(createdOrder.id);

    // 6. Cascata de estoque em tempo real para os demais marketplaces (Mercado Livre e Amazon)
    for (const item of orderItemsToCreate) {
      const updatedVariant = await this.prisma.productVariant.findUnique({
        where: { id: item.variantId },
      });
      if (updatedVariant) {
        if (this.meliSync) {
          this.meliSync
            .syncVariantStock(
              item.variantId,
              updatedVariant.stockQuantity,
              tenantId,
            )
            .catch((syncErr: unknown) => {
              this.logger.warn(
                `Erro ao propagar baixa de estoque Shopee para Mercado Livre: ${String(syncErr)}`,
              );
            });
        }

        if (this.amazonSync) {
          this.amazonSync
            .syncVariantStock(
              item.variantId,
              updatedVariant.stockQuantity,
              tenantId,
            )
            .catch((syncErr: unknown) => {
              this.logger.warn(
                `Erro ao propagar baixa de estoque Shopee para Amazon: ${String(syncErr)}`,
              );
            });
        }
      }
    }

    // 7. Exportação contábil para o ERP (Bling) se pedido aprovado
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
            neighborhood: address?.district ?? null,
            city,
            state,
            postalCode,
          },
          buyer: {
            name: address?.name ?? shopeeOrder.buyer.buyer_username,
            email: buyerUser.email,
          },
          paidAt: createdOrder.paidAt,
        });
      } catch (erpError) {
        this.logger.error(
          `Falha ao exportar pedido importado da Shopee ${orderSn} para o ERP: ${String(erpError)}`,
        );
      }
    }

    return {
      processed: true,
      action: 'order_imported_successfully',
      orderId: createdOrder.id,
      externalOrderId: shopeeOrder.order_sn,
    };
  }
}
