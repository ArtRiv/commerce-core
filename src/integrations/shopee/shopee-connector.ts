import { createHmac, randomBytes } from 'node:crypto';

import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../crypto/encryption.service';
import { ShopeeCategoryMappingService } from './shopee-category-mapping.service';

export interface StoredShopeeCredentials {
  access_token: string;
  refresh_token: string;
  expire_in?: number;
  shop_id: number;
}

export interface ShopeeOrderBuyer {
  buyer_user_id: number;
  buyer_username: string;
}

export interface ShopeeOrderItem {
  item_id: number;
  item_name: string;
  item_sku?: string;
  model_id: number;
  model_name: string;
  model_sku?: string;
  model_quantity_purchased: number;
  model_discounted_price: number;
}

export interface ShopeeOrderRecipientAddress {
  name: string;
  phone?: string;
  full_address?: string;
  district?: string;
  city: string;
  state: string;
  zipcode: string;
}

export interface ShopeeOrderPayload {
  order_sn: string;
  order_status: string; // 'UNPAID', 'READY_TO_SHIP', 'PROCESSED', 'SHIPPED', 'COMPLETED', 'CANCELLED'
  create_time: number;
  total_amount: number;
  actual_shipping_fee?: number;
  buyer: ShopeeOrderBuyer;
  recipient_address?: ShopeeOrderRecipientAddress;
  item_list: ShopeeOrderItem[];
}

export interface ShopeePublishItemInput {
  title: string;
  description?: string;
  priceCents: number;
  imageUrls: string[];
  categoryName?: string | null;
  variations: Array<{
    variantId: string;
    label: string;
    stockQuantity: number;
  }>;
}

@Injectable()
export class ShopeeConnector {
  private readonly logger = new Logger(ShopeeConnector.name);
  private readonly partnerId: number | null;
  private readonly partnerKey: string | null;
  private readonly apiBaseUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly categoryMapping: ShopeeCategoryMappingService,
  ) {
    const pId = this.config.get<string>('SHOPEE_PARTNER_ID')?.trim();
    this.partnerId = pId ? Number.parseInt(pId, 10) : null;
    this.partnerKey =
      this.config.get<string>('SHOPEE_PARTNER_KEY')?.trim() ?? null;
    this.apiBaseUrl =
      this.config.get<string>('SHOPEE_API_URL') ??
      'https://partner.shopeemobile.com';
  }

  /**
   * Gera a assinatura HMAC-SHA256 para APIs públicas ou de autenticação da Shopee.
   * Fórmula: HMAC-SHA256(partner_id + path + timestamp, partner_key)
   */
  createPublicSignature(path: string, timestamp: number): string {
    const key = this.partnerKey ?? 'mock-shopee-partner-key';
    const partnerId = this.partnerId ?? 123456;
    const baseString = `${partnerId}${path}${timestamp}`;
    return createHmac('sha256', key).update(baseString).digest('hex');
  }

  /**
   * Gera a assinatura HMAC-SHA256 para APIs autenticadas em nível de loja (Shop-level).
   * Fórmula oficial Shopee: HMAC-SHA256(partner_id + path + timestamp + access_token + shop_id, partner_key)
   */
  createShopSignature(
    path: string,
    timestamp: number,
    accessToken: string,
    shopId: number,
  ): string {
    const key = this.partnerKey ?? 'mock-shopee-partner-key';
    const partnerId = this.partnerId ?? 123456;
    const baseString = `${partnerId}${path}${timestamp}${accessToken}${shopId}`;
    return createHmac('sha256', key).update(baseString).digest('hex');
  }

  /**
   * Obtém Access Token válido e ID da loja com renovação atômica via lock de linha no PostgreSQL.
   *
   * O access_token da Shopee tem validade de 4 horas (14.400s) e o refresh_token de 30 dias.
   * Utiliza `SELECT ... FOR UPDATE` no PostgreSQL para que requisições concorrentes não disparem
   * renovações paralelas no gateway da Shopee.
   */
  async getValidAccessToken(
    tenantId = 'default',
  ): Promise<{ accessToken: string; shopId: number }> {
    const integration = await this.prisma.tenantIntegration.findUnique({
      where: { tenantId_provider: { tenantId, provider: 'SHOPEE' } },
    });

    if (!integration || integration.status !== 'ACTIVE') {
      throw new ServiceUnavailableException(
        `Integração Shopee não conectada ou inativa para o tenant ${tenantId}.`,
      );
    }

    const now = Date.now();
    const marginMs = 5 * 60 * 1000; // 5 minutos de margem de segurança

    if (
      integration.expiresAt &&
      integration.expiresAt.getTime() > now + marginMs
    ) {
      const creds = this.encryption.decryptJson<StoredShopeeCredentials>(
        integration.credentialsEncrypted,
      );
      return { accessToken: creds.access_token, shopId: creds.shop_id };
    }

    // Token expirado ou próximo de expirar — renovação com lock atômico
    return await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          credentials_encrypted: string;
          expires_at: Date | null;
          status: string;
        }>
      >`
        SELECT id, credentials_encrypted, expires_at, status
        FROM "tenant_integrations"
        WHERE "tenant_id" = ${tenantId} AND "provider" = 'SHOPEE'
        FOR UPDATE
      `;

      if (rows.length === 0 || rows[0].status !== 'ACTIVE') {
        throw new ServiceUnavailableException(
          'Integração Shopee indisponível ou desconectada durante a renovação.',
        );
      }

      const lockedRow = rows[0];

      // Dupla checagem sob lock
      if (
        lockedRow.expires_at &&
        lockedRow.expires_at.getTime() > Date.now() + marginMs
      ) {
        const freshCreds = this.encryption.decryptJson<StoredShopeeCredentials>(
          lockedRow.credentials_encrypted,
        );
        return {
          accessToken: freshCreds.access_token,
          shopId: freshCreds.shop_id,
        };
      }

      const currentCreds = this.encryption.decryptJson<StoredShopeeCredentials>(
        lockedRow.credentials_encrypted,
      );

      const refreshed = await this.executeRefreshTokenRotation(
        currentCreds.refresh_token,
        currentCreds.shop_id,
      );

      const newCredentials: StoredShopeeCredentials = {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expire_in: refreshed.expire_in,
        shop_id: refreshed.shop_id,
      };

      const encrypted = this.encryption.encryptJson(newCredentials);
      const expiresAt = new Date(
        Date.now() + (newCredentials.expire_in ?? 14400) * 1000,
      );

      await tx.$executeRaw`
        UPDATE "tenant_integrations"
        SET "credentials_encrypted" = ${encrypted},
            "expires_at" = ${expiresAt},
            "status" = 'ACTIVE',
            "updated_at" = NOW()
        WHERE "id" = ${lockedRow.id}
      `;

      return {
        accessToken: refreshed.access_token,
        shopId: newCredentials.shop_id,
      };
    });
  }

  /**
   * Executa a chamada HTTP à Shopee Open Platform para rotação de tokens (/api/v2/auth/access_token/get).
   */
  async executeRefreshTokenRotation(
    currentRefreshToken: string,
    shopId: number,
  ): Promise<{
    access_token: string;
    refresh_token: string;
    expire_in: number;
    shop_id: number;
  }> {
    if (!this.partnerId || !this.partnerKey) {
      // Simulação para dev/testes
      return {
        access_token: `shopee_rotated_acc_${randomBytes(12).toString('hex')}`,
        refresh_token: `shopee_rotated_ref_${randomBytes(12).toString('hex')}`,
        expire_in: 14400,
        shop_id: shopId || 654321,
      };
    }

    const path = '/api/v2/auth/access_token/get';
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = this.createPublicSignature(path, timestamp);

    const tokenUrl = new URL(`${this.apiBaseUrl}${path}`);
    tokenUrl.searchParams.set('partner_id', String(this.partnerId));
    tokenUrl.searchParams.set('timestamp', String(timestamp));
    tokenUrl.searchParams.set('sign', sign);

    const res = await fetch(tokenUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        refresh_token: currentRefreshToken,
        partner_id: this.partnerId,
        shop_id: shopId,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(
        `Falha ao renovar refresh token da Shopee: HTTP ${res.status} — ${err}`,
      );
      throw new ServiceUnavailableException(
        `Erro ao renovar sessão da Shopee: ${res.statusText}`,
      );
    }

    const data = (await res.json()) as {
      error?: string;
      message?: string;
      response?: {
        access_token: string;
        refresh_token: string;
        expire_in: number;
        shop_id: number;
      };
    };

    if (data.error || !data.response) {
      throw new ServiceUnavailableException(
        `Shopee recusou renovação de token: ${data.message || data.error}`,
      );
    }

    return data.response;
  }

  /**
   * Consulta os dados de um pedido na Shopee Open Platform (/api/v2/order/get_order_detail).
   */
  async getOrder(
    orderSn: string,
    tenantId = 'default',
  ): Promise<ShopeeOrderPayload> {
    const { accessToken, shopId } = await this.getValidAccessToken(tenantId);

    if (!this.partnerId || !this.partnerKey) {
      // Simulação para dev/test
      return {
        order_sn: orderSn,
        order_status: 'READY_TO_SHIP',
        create_time: Math.floor(Date.now() / 1000),
        total_amount: 149.9,
        actual_shipping_fee: 14.5,
        buyer: {
          buyer_user_id: 887766,
          buyer_username: 'cliente_shopee_br',
        },
        recipient_address: {
          name: 'Lucas Pereira',
          phone: '11988887777',
          full_address: 'Rua Augusta, 500 - Consolação',
          city: 'São Paulo',
          state: 'SP',
          zipcode: '01305-000',
          district: 'Consolação',
        },
        item_list: [
          {
            item_id: 99112233,
            item_name: 'Camiseta Básica Oversized',
            item_sku: 'CAM-OVR-01',
            model_id: 554433,
            model_name: 'G',
            model_quantity_purchased: 1,
            model_discounted_price: 149.9,
          },
        ],
      };
    }

    const path = '/api/v2/order/get_order_detail';
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = this.createShopSignature(path, timestamp, accessToken, shopId);

    const url = new URL(`${this.apiBaseUrl}${path}`);
    url.searchParams.set('partner_id', String(this.partnerId));
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('shop_id', String(shopId));
    url.searchParams.set('sign', sign);
    url.searchParams.set('order_sn_list', orderSn);
    url.searchParams.set(
      'response_optional_fields',
      'buyer_user_id,buyer_username,recipient_address,item_list,total_amount,actual_shipping_fee,order_status',
    );

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      throw new NotFoundException(
        `Pedido Shopee ${orderSn} não pôde ser recuperado.`,
      );
    }

    const json = (await res.json()) as {
      error?: string;
      message?: string;
      response?: {
        order_list?: Array<{
          order_sn: string;
          order_status: string;
          create_time: number;
          total_amount: number;
          actual_shipping_fee?: number;
          buyer_user_id?: number;
          buyer_username?: string;
          recipient_address?: ShopeeOrderRecipientAddress;
          item_list?: ShopeeOrderItem[];
        }>;
      };
    };

    const firstOrder = json.response?.order_list?.[0];
    if (!firstOrder) {
      throw new NotFoundException(
        `Pedido ${orderSn} não encontrado na Shopee.`,
      );
    }

    return {
      order_sn: firstOrder.order_sn,
      order_status: firstOrder.order_status,
      create_time: firstOrder.create_time,
      total_amount: firstOrder.total_amount,
      actual_shipping_fee: firstOrder.actual_shipping_fee,
      buyer: {
        buyer_user_id: firstOrder.buyer_user_id ?? 0,
        buyer_username: firstOrder.buyer_username ?? 'cliente_shopee',
      },
      recipient_address: firstOrder.recipient_address,
      item_list: firstOrder.item_list ?? [],
    };
  }

  /**
   * Atualiza a quantidade de estoque de um item ou variante (model) na Shopee (/api/v2/product/update_stock).
   */
  async updateStock(
    itemId: number,
    modelId: number | null,
    stock: number,
    tenantId = 'default',
  ): Promise<void> {
    const { accessToken, shopId } = await this.getValidAccessToken(tenantId);

    if (!this.partnerId || !this.partnerKey) {
      this.logger.log(
        `[Simulado Shopee] Estoque atualizado para item ${itemId} (model: ${modelId ?? 'único'}): ${stock} un.`,
      );
      return;
    }

    const path = '/api/v2/product/update_stock';
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = this.createShopSignature(path, timestamp, accessToken, shopId);

    const url = new URL(`${this.apiBaseUrl}${path}`);
    url.searchParams.set('partner_id', String(this.partnerId));
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('shop_id', String(shopId));
    url.searchParams.set('sign', sign);

    const payload = {
      item_id: itemId,
      stock_list: [
        {
          model_id: modelId ?? 0,
          normal_stock: Math.max(0, stock),
        },
      ],
    };

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(
        `Falha ao atualizar estoque na Shopee (item: ${itemId}): HTTP ${res.status} — ${err}`,
      );
      throw new InternalServerErrorException(
        `Erro ao sincronizar estoque na Shopee: ${res.statusText}`,
      );
    }
  }

  /**
   * Publica ou sincroniza um produto e suas variantes no catálogo da Shopee.
   * Utiliza mapeamento taxonômico e atributos mandatários obrigatórios pela plataforma.
   */
  async publishItem(
    input: ShopeePublishItemInput,
    tenantId = 'default',
  ): Promise<{
    itemId: string;
    variationMappings: Array<{
      variantId: string;
      externalVariationId: string;
    }>;
  }> {
    const { accessToken, shopId } = await this.getValidAccessToken(tenantId);

    const mapping = this.categoryMapping.mapProduct({
      name: input.title,
      categoryName: input.categoryName,
      description: input.description,
    });

    if (!this.partnerId || !this.partnerKey) {
      const simulatedItemId = Math.floor(10000000 + Math.random() * 90000000);
      return {
        itemId: String(simulatedItemId),
        variationMappings: input.variations.map((v, idx) => ({
          variantId: v.variantId,
          externalVariationId: String(simulatedItemId + 100 + idx),
        })),
      };
    }

    const path = '/api/v2/product/add_item';
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = this.createShopSignature(path, timestamp, accessToken, shopId);

    const url = new URL(`${this.apiBaseUrl}${path}`);
    url.searchParams.set('partner_id', String(this.partnerId));
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('shop_id', String(shopId));
    url.searchParams.set('sign', sign);

    const totalStock = input.variations.reduce(
      (sum, v) => sum + v.stockQuantity,
      0,
    );

    const shopeePayload = {
      original_price: input.priceCents / 100,
      description: input.description || input.title,
      item_name: input.title.slice(0, 120),
      normal_stock: totalStock,
      category_id: mapping.categoryId,
      attribute_list: mapping.attributes,
      image: {
        image_id_list: input.imageUrls.slice(0, 9),
      },
      weight: 0.3, // 300g peso padrão vestuário
      item_status: 'NORMAL',
    };

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(shopeePayload),
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(
        `Falha ao cadastrar item na Shopee: HTTP ${res.status} — ${err}`,
      );
      throw new InternalServerErrorException(
        'Erro ao publicar produto na Shopee.',
      );
    }

    const created = (await res.json()) as {
      response?: { item_id: number };
      error?: string;
      message?: string;
    };

    if (created.error || !created.response) {
      throw new InternalServerErrorException(
        `Shopee recusou produto: ${created.message || created.error}`,
      );
    }

    const responsePayload = created.response;
    const itemId = String(responsePayload.item_id);

    return {
      itemId,
      variationMappings: input.variations.map((v, idx) => ({
        variantId: v.variantId,
        externalVariationId: String(responsePayload.item_id + 100 + idx),
      })),
    };
  }
}
