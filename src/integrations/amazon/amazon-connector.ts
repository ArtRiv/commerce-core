import { randomBytes } from 'node:crypto';

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
import {
  AmazonCatalogMappingService,
  type AmazonListingBuildInput,
} from './amazon-catalog-mapping.service';
import { AmazonSigV4, type AwsSigV4Credentials } from './amazon-sigv4';

export interface StoredAmazonCredentials {
  access_token: string;
  refresh_token: string;
  selling_partner_id: string;
  marketplace_id: string;
  client_id?: string;
}

export interface AmazonOrderBuyer {
  name: string;
  email?: string;
  phone?: string;
  taxRegistrationId?: string;
}

export interface AmazonOrderItem {
  OrderItemId: string;
  SellerSKU: string;
  Title: string;
  QuantityOrdered: number;
  ItemPrice?: {
    Amount: string;
    CurrencyCode: string;
  };
}

export interface AmazonOrderAddress {
  Name: string;
  AddressLine1: string;
  AddressLine2?: string;
  City: string;
  StateOrRegion: string;
  PostalCode: string;
  CountryCode: string;
}

export interface AmazonOrderPayload {
  AmazonOrderId: string;
  OrderStatus: string; // 'Unshipped', 'PartiallyShipped', 'Shipped', 'Canceled'
  PurchaseDate: string;
  OrderTotal?: {
    Amount: string;
    CurrencyCode: string;
  };
  ShippingPrice?: {
    Amount: string;
    CurrencyCode: string;
  };
  BuyerInfo: AmazonOrderBuyer;
  ShippingAddress: AmazonOrderAddress;
  OrderItems: AmazonOrderItem[];
}

export interface AmazonFeedSubmitResult {
  feedId: string;
  feedDocumentId: string;
  feedType: string;
  status: string;
}

@Injectable()
export class AmazonConnector {
  private readonly logger = new Logger(AmazonConnector.name);
  private readonly spApiBaseUrl: string;
  private readonly lwaTokenUrl: string;
  private readonly clientId: string | null;
  private readonly clientSecret: string | null;
  private readonly awsCredentials: AwsSigV4Credentials | null;
  private readonly awsRegion: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly catalogMapping: AmazonCatalogMappingService,
  ) {
    this.spApiBaseUrl =
      this.config.get<string>('AMAZON_SPAPI_BASE_URL') ??
      'https://sellingpartnerapi-na.amazon.com';

    this.lwaTokenUrl =
      this.config.get<string>('AMAZON_LWA_TOKEN_URL') ??
      'https://api.amazon.com/auth/o2/token';

    this.clientId = this.config.get<string>('AMAZON_CLIENT_ID')?.trim() ?? null;
    this.clientSecret =
      this.config.get<string>('AMAZON_CLIENT_SECRET')?.trim() ?? null;

    const accessKeyId = this.config
      .get<string>('AMAZON_AWS_ACCESS_KEY_ID')
      ?.trim();
    const secretAccessKey = this.config
      .get<string>('AMAZON_AWS_SECRET_ACCESS_KEY')
      ?.trim();

    if (accessKeyId && secretAccessKey) {
      this.awsCredentials = {
        accessKeyId,
        secretAccessKey,
        sessionToken: this.config
          .get<string>('AMAZON_AWS_SESSION_TOKEN')
          ?.trim(),
      };
    } else {
      this.awsCredentials = null;
    }

    this.awsRegion =
      this.config.get<string>('AMAZON_AWS_REGION')?.trim() ?? 'us-east-1';
  }

  /**
   * Obtém token de acesso LWA válido com renovação atômica via lock de linha no PostgreSQL.
   *
   * O access_token LWA da Amazon expira em 3600 segundos (1h).
   * O lock `SELECT ... FOR UPDATE` garante que múltiplas requisições simultâneas
   * não disputem ou dupliquem a renovação do token.
   */
  async getValidAccessToken(tenantId = 'default'): Promise<{
    accessToken: string;
    sellingPartnerId: string;
    marketplaceId: string;
  }> {
    const integration = await this.prisma.tenantIntegration.findUnique({
      where: { tenantId_provider: { tenantId, provider: 'AMAZON' } },
    });

    if (!integration || integration.status !== 'ACTIVE') {
      throw new ServiceUnavailableException(
        `Integração Amazon SP-API não conectada ou inativa para o tenant ${tenantId}.`,
      );
    }

    const now = Date.now();
    const marginMs = 5 * 60 * 1000; // 5 minutos de margem de segurança

    if (
      integration.expiresAt &&
      integration.expiresAt.getTime() > now + marginMs
    ) {
      const creds = this.encryption.decryptJson<StoredAmazonCredentials>(
        integration.credentialsEncrypted,
      );
      return {
        accessToken: creds.access_token,
        sellingPartnerId: creds.selling_partner_id,
        marketplaceId: creds.marketplace_id,
      };
    }

    // Token expirado ou prestes a expirar — renovação sob row-level lock no PostgreSQL
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
        WHERE "tenant_id" = ${tenantId} AND "provider" = 'AMAZON'
        FOR UPDATE
      `;

      if (rows.length === 0 || rows[0].status !== 'ACTIVE') {
        throw new ServiceUnavailableException(
          'Integração Amazon SP-API indisponível durante a renovação.',
        );
      }

      const lockedRow = rows[0];

      // Dupla checagem dentro da transação sob lock
      if (
        lockedRow.expires_at &&
        lockedRow.expires_at.getTime() > Date.now() + marginMs
      ) {
        const freshCreds = this.encryption.decryptJson<StoredAmazonCredentials>(
          lockedRow.credentials_encrypted,
        );
        return {
          accessToken: freshCreds.access_token,
          sellingPartnerId: freshCreds.selling_partner_id,
          marketplaceId: freshCreds.marketplace_id,
        };
      }

      const currentCreds = this.encryption.decryptJson<StoredAmazonCredentials>(
        lockedRow.credentials_encrypted,
      );

      const refreshed = await this.executeLwaTokenRefresh(
        currentCreds.refresh_token,
      );

      const updatedCredsToStore: StoredAmazonCredentials = {
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken,
        selling_partner_id: currentCreds.selling_partner_id,
        marketplace_id: currentCreds.marketplace_id,
        client_id: currentCreds.client_id,
      };

      const encrypted = this.encryption.encryptJson(updatedCredsToStore);
      const newExpiresAt = new Date(Date.now() + refreshed.expiresIn * 1000);

      await tx.tenantIntegration.update({
        where: { id: lockedRow.id },
        data: {
          credentialsEncrypted: encrypted,
          expiresAt: newExpiresAt,
          updatedAt: new Date(),
        },
      });

      this.logger.log(
        `Token LWA da Amazon renovado com sucesso sob lock PostgreSQL para tenant ${tenantId}.`,
      );

      return {
        accessToken: refreshed.accessToken,
        sellingPartnerId: currentCreds.selling_partner_id,
        marketplaceId: currentCreds.marketplace_id,
      };
    });
  }

  private async executeLwaTokenRefresh(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    if (!this.clientId || !this.clientSecret) {
      this.logger.warn(
        'Modo simulado: gerando token LWA simulado para renovação na Amazon SP-API.',
      );
      return {
        accessToken: `Atza|simulated-${randomBytes(24).toString('hex')}`,
        refreshToken,
        expiresIn: 3600,
      };
    }

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const response = await fetch(this.lwaTokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errText = await response.text();
      this.logger.error(`Falha ao renovar token LWA na Amazon: ${errText}`);
      throw new InternalServerErrorException(
        `Falha ao renovar token LWA com a Amazon (HTTP ${response.status}).`,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresIn: data.expires_in ?? 3600,
    };
  }

  /**
   * Consulta os dados completos de um pedido na Orders API v0 da Amazon.
   */
  async getOrder(
    amazonOrderId: string,
    tenantId = 'default',
  ): Promise<AmazonOrderPayload> {
    const { accessToken } = await this.getValidAccessToken(tenantId);

    // Se não há credenciais AWS configuradas, retorna simulação consistente para dev/testes
    if (!this.awsCredentials) {
      this.logger.log(
        `[Simulado SP-API] Retornando dados simulados para pedido ${amazonOrderId}.`,
      );
      return {
        AmazonOrderId: amazonOrderId,
        OrderStatus: 'Unshipped',
        PurchaseDate: new Date().toISOString(),
        OrderTotal: {
          Amount: '219.80',
          CurrencyCode: 'BRL',
        },
        ShippingPrice: {
          Amount: '29.90',
          CurrencyCode: 'BRL',
        },
        BuyerInfo: {
          name: 'Comprador Amazon Brasil',
          email: 'buyer-simulated@marketplace.amazon.com',
          phone: '+5511988887777',
          taxRegistrationId: '123.456.789-00',
        },
        ShippingAddress: {
          Name: 'Comprador Amazon Brasil',
          AddressLine1: 'Av. Paulista, 1000 - Bela Vista',
          AddressLine2: 'Apto 101',
          City: 'São Paulo',
          StateOrRegion: 'SP',
          PostalCode: '01310-100',
          CountryCode: 'BR',
        },
        OrderItems: [
          {
            OrderItemId: `item-${amazonOrderId}-01`,
            SellerSKU: 'AVESSO-CAM-OVER-BLK-G',
            Title: 'Camiseta Oversized Preta - G',
            QuantityOrdered: 1,
            ItemPrice: {
              Amount: '189.90',
              CurrencyCode: 'BRL',
            },
          },
        ],
      };
    }

    const orderUrl = `${this.spApiBaseUrl}/orders/v0/orders/${amazonOrderId}`;
    const itemsUrl = `${this.spApiBaseUrl}/orders/v0/orders/${amazonOrderId}/orderItems`;

    const signedOrder = AmazonSigV4.sign({
      method: 'GET',
      url: orderUrl,
      headers: {
        'x-amz-access-token': accessToken,
      },
      credentials: this.awsCredentials,
      region: this.awsRegion,
    });

    const orderRes = await fetch(orderUrl, {
      method: 'GET',
      headers: signedOrder.headers,
    });

    if (!orderRes.ok) {
      if (orderRes.status === 404) {
        throw new NotFoundException(
          `Pedido Amazon ${amazonOrderId} não encontrado.`,
        );
      }
      throw new ServiceUnavailableException(
        `Erro ao buscar pedido na Orders API da Amazon (HTTP ${orderRes.status}).`,
      );
    }

    const orderJson = (await orderRes.json()) as {
      payload: {
        AmazonOrderId?: string;
        OrderStatus?: string;
        PurchaseDate?: string;
        OrderTotal?: { Amount: string; CurrencyCode: string };
        BuyerInfo?: AmazonOrderBuyer;
        ShippingAddress?: AmazonOrderAddress;
      };
    };

    const signedItems = AmazonSigV4.sign({
      method: 'GET',
      url: itemsUrl,
      headers: {
        'x-amz-access-token': accessToken,
      },
      credentials: this.awsCredentials,
      region: this.awsRegion,
    });

    const itemsRes = await fetch(itemsUrl, {
      method: 'GET',
      headers: signedItems.headers,
    });

    const itemsJson = itemsRes.ok
      ? ((await itemsRes.json()) as {
          payload: { OrderItems: AmazonOrderItem[] };
        })
      : { payload: { OrderItems: [] } };

    const payload = orderJson.payload;
    const buyerInfo = (payload.BuyerInfo ?? {}) as AmazonOrderBuyer;
    const shippingAddress = (payload.ShippingAddress ??
      {}) as AmazonOrderAddress;

    return {
      AmazonOrderId: payload.AmazonOrderId ?? amazonOrderId,
      OrderStatus: payload.OrderStatus ?? 'Unshipped',
      PurchaseDate: payload.PurchaseDate ?? new Date().toISOString(),
      OrderTotal: payload.OrderTotal ?? {
        Amount: '0.00',
        CurrencyCode: 'BRL',
      },
      BuyerInfo: buyerInfo,
      ShippingAddress: shippingAddress,
      OrderItems: itemsJson.payload.OrderItems,
    };
  }

  /**
   * Atualiza estoque e opcionalmente preço de uma variante na Listings Items API v2021-08-01.
   */
  async updateListingItem(
    sku: string,
    input: { stockQuantity: number; priceCents?: number },
    tenantId = 'default',
  ): Promise<{ success: boolean; sku: string; quantity: number }> {
    const { accessToken, sellingPartnerId, marketplaceId } =
      await this.getValidAccessToken(tenantId);

    const patches = this.catalogMapping.buildStockAndPricePatches(
      input.stockQuantity,
      input.priceCents,
    );

    const body = {
      productType: 'CLOTHING',
      patches,
    };

    if (!this.awsCredentials) {
      this.logger.log(
        `[Simulado SP-API] Estoque atualizado para SKU ${sku}: ${input.stockQuantity} un (preço: ${input.priceCents ?? 'inalterado'}).`,
      );
      return { success: true, sku, quantity: input.stockQuantity };
    }

    const url = `${this.spApiBaseUrl}/listings/2021-08-01/items/${sellingPartnerId}/${encodeURIComponent(sku)}?marketplaceIds=${marketplaceId}`;

    const signed = AmazonSigV4.sign({
      method: 'PATCH',
      url,
      headers: {
        'Content-Type': 'application/json',
        'x-amz-access-token': accessToken,
      },
      body,
      credentials: this.awsCredentials,
      region: this.awsRegion,
    });

    const res = await fetch(url, {
      method: 'PATCH',
      headers: signed.headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(
        `Erro ao atualizar listing item Amazon (${sku}): ${err}`,
      );
      throw new ServiceUnavailableException(
        `Falha ao atualizar listing na Amazon (HTTP ${res.status}).`,
      );
    }

    return { success: true, sku, quantity: input.stockQuantity };
  }

  /**
   * Publica ou substitui um anúncio completo na Listings Items API v2021-08-01.
   */
  async putListingItem(
    input: AmazonListingBuildInput,
    tenantId = 'default',
  ): Promise<{ success: boolean; sku: string }> {
    const { accessToken, sellingPartnerId, marketplaceId } =
      await this.getValidAccessToken(tenantId);

    const payload = this.catalogMapping.buildListingPayload({
      ...input,
      marketplaceId,
    });

    if (!this.awsCredentials) {
      this.logger.log(
        `[Simulado SP-API] Anúncio publicado com sucesso para SKU ${input.sku} (${payload.productType}).`,
      );
      return { success: true, sku: input.sku };
    }

    const url = `${this.spApiBaseUrl}/listings/2021-08-01/items/${sellingPartnerId}/${encodeURIComponent(input.sku)}?marketplaceIds=${marketplaceId}`;

    const signed = AmazonSigV4.sign({
      method: 'PUT',
      url,
      headers: {
        'Content-Type': 'application/json',
        'x-amz-access-token': accessToken,
      },
      body: payload,
      credentials: this.awsCredentials,
      region: this.awsRegion,
    });

    const res = await fetch(url, {
      method: 'PUT',
      headers: signed.headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(
        `Erro ao publicar anúncio na Amazon (${input.sku}): ${err}`,
      );
      throw new ServiceUnavailableException(
        `Falha ao publicar anúncio na Amazon (HTTP ${res.status}).`,
      );
    }

    return { success: true, sku: input.sku };
  }

  /**
   * Envia documentos e feeds em lote via Feeds API v2021-06-30.
   */
  async submitFeed(
    feedType: string,
    feedDocument: unknown,
    tenantId = 'default',
  ): Promise<AmazonFeedSubmitResult> {
    const { accessToken, marketplaceId } =
      await this.getValidAccessToken(tenantId);

    if (!this.awsCredentials) {
      const fakeDocId = `feed-doc-${randomBytes(8).toString('hex')}`;
      const fakeFeedId = `feed-${randomBytes(8).toString('hex')}`;
      this.logger.log(
        `[Simulado SP-API] Feed em lote ${feedType} submetido (Feed ID: ${fakeFeedId}).`,
      );
      return {
        feedId: fakeFeedId,
        feedDocumentId: fakeDocId,
        feedType,
        status: 'IN_QUEUE',
      };
    }

    // 1. Cria documento do feed
    const docUrl = `${this.spApiBaseUrl}/feeds/2021-06-30/documents`;
    const docBody = { contentType: 'application/json; charset=UTF-8' };

    const signedDoc = AmazonSigV4.sign({
      method: 'POST',
      url: docUrl,
      headers: {
        'Content-Type': 'application/json',
        'x-amz-access-token': accessToken,
      },
      body: docBody,
      credentials: this.awsCredentials,
      region: this.awsRegion,
    });

    const docRes = await fetch(docUrl, {
      method: 'POST',
      headers: signedDoc.headers,
      body: JSON.stringify(docBody),
    });

    if (!docRes.ok) {
      throw new ServiceUnavailableException(
        'Falha ao criar feed document na Amazon.',
      );
    }

    const docJson = (await docRes.json()) as {
      feedDocumentId: string;
      url: string;
    };

    // 2. Upload do payload para a URL do S3 assinada retornada pela Amazon
    await fetch(docJson.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(feedDocument),
    });

    // 3. Cria e agenda o processamento do feed
    const feedsUrl = `${this.spApiBaseUrl}/feeds/2021-06-30/feeds`;
    const feedsBody = {
      feedType,
      marketplaceIds: [marketplaceId],
      inputFeedDocumentId: docJson.feedDocumentId,
    };

    const signedFeeds = AmazonSigV4.sign({
      method: 'POST',
      url: feedsUrl,
      headers: {
        'Content-Type': 'application/json',
        'x-amz-access-token': accessToken,
      },
      body: feedsBody,
      credentials: this.awsCredentials,
      region: this.awsRegion,
    });

    const feedsRes = await fetch(feedsUrl, {
      method: 'POST',
      headers: signedFeeds.headers,
      body: JSON.stringify(feedsBody),
    });

    if (!feedsRes.ok) {
      throw new ServiceUnavailableException('Falha ao agendar feed na Amazon.');
    }

    const feedsJson = (await feedsRes.json()) as { feedId: string };

    return {
      feedId: feedsJson.feedId,
      feedDocumentId: docJson.feedDocumentId,
      feedType,
      status: 'IN_QUEUE',
    };
  }
}
