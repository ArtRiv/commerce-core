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

export interface StoredCredentials {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  scope?: string;
  user_id?: number;
}

export interface MeliOrderBuyer {
  id: number;
  nickname: string;
  first_name?: string;
  last_name?: string;
  email?: string;
}

export interface MeliOrderItem {
  item: {
    id: string;
    title: string;
    variation_id?: number | null;
  };
  quantity: number;
  unit_price: number;
}

export interface MeliOrderShippingAddress {
  street_name?: string;
  street_number?: string;
  comment?: string;
  city?: { name: string };
  state?: { name: string };
  zip_code?: string;
}

export interface MeliOrderPayload {
  id: number;
  status: string; // 'paid', 'cancelled', etc.
  date_created: string;
  total_amount: number;
  shipping_cost?: number;
  order_items: MeliOrderItem[];
  buyer: MeliOrderBuyer;
  shipping?: {
    receiver_address?: MeliOrderShippingAddress;
  };
}

export interface MeliItemPayload {
  id: string;
  title: string;
  price: number;
  available_quantity: number;
  status: string;
}

export interface MeliPublishItemInput {
  title: string;
  description?: string;
  priceCents: number;
  imageUrls: string[];
  variations: Array<{
    variantId: string;
    label: string;
    stockQuantity: number;
  }>;
}

@Injectable()
export class MercadoLivreConnector {
  private readonly logger = new Logger(MercadoLivreConnector.name);
  private readonly clientId: string | null;
  private readonly clientSecret: string | null;
  private readonly apiBaseUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {
    this.clientId =
      this.config.get<string>('MERCADO_LIVRE_CLIENT_ID')?.trim() ?? null;
    this.clientSecret =
      this.config.get<string>('MERCADO_LIVRE_CLIENT_SECRET')?.trim() ?? null;
    this.apiBaseUrl =
      this.config.get<string>('MERCADO_LIVRE_API_URL') ??
      'https://api.mercadolibre.com';
  }

  /**
   * Obtém um Access Token válido garantindo a renovação segura de refresh tokens rotativos de uso único.
   *
   * O controle de concorrência é executado diretamente no PostgreSQL através de
   * `SELECT ... FOR UPDATE` (ou lock atômico na transação). Se múltiplas requisições
   * concorrentes tentarem renovar o token expirado simultaneamente, apenas a primeira
   * executará a chamada HTTP externa ao Mercado Livre. As demais aguardarão o lock,
   * verificarão que o token já foi renovado e retornarão o novo token imediatamente,
   * prevenindo invalidação indevida da autorização do lojista.
   */
  async getValidAccessToken(tenantId = 'default'): Promise<string> {
    const integration = await this.prisma.tenantIntegration.findUnique({
      where: { tenantId_provider: { tenantId, provider: 'MERCADO_LIVRE' } },
    });

    if (!integration || integration.status !== 'ACTIVE') {
      throw new ServiceUnavailableException(
        `Integração Mercado Livre não conectada ou inativa para o tenant ${tenantId}.`,
      );
    }

    const now = Date.now();
    const marginMs = 5 * 60 * 1000; // 5 minutos de margem de segurança

    // Se o token ainda for válido além da margem, retorna imediatamente sem lock
    if (
      integration.expiresAt &&
      integration.expiresAt.getTime() > now + marginMs
    ) {
      const creds = this.encryption.decryptJson<StoredCredentials>(
        integration.credentialsEncrypted,
      );
      return creds.access_token;
    }

    // Token expirando ou expirado — executa renovação sob lock exclusivo no PostgreSQL
    return await this.prisma.$transaction(async (tx) => {
      // 1. Lock exclusivo na linha do tenant no PostgreSQL
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
        WHERE "tenant_id" = ${tenantId} AND "provider" = 'MERCADO_LIVRE'
        FOR UPDATE
      `;

      if (rows.length === 0 || rows[0].status !== 'ACTIVE') {
        throw new ServiceUnavailableException(
          'Integração Mercado Livre indisponível ou desconectada durante a renovação.',
        );
      }

      const lockedRow = rows[0];

      // 2. Dupla checagem: outra requisição concorrente pode ter renovado o token enquanto aguardávamos o lock
      if (
        lockedRow.expires_at &&
        lockedRow.expires_at.getTime() > Date.now() + marginMs
      ) {
        const freshCreds = this.encryption.decryptJson<StoredCredentials>(
          lockedRow.credentials_encrypted,
        );
        return freshCreds.access_token;
      }

      // 3. Somos os primeiros a obter o lock: executa a rotação de refresh token
      const currentCreds = this.encryption.decryptJson<StoredCredentials>(
        lockedRow.credentials_encrypted,
      );

      const refreshed = await this.executeRefreshTokenRotation(
        currentCreds.refresh_token,
      );

      const newCredentials: StoredCredentials = {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        token_type: refreshed.token_type ?? currentCreds.token_type ?? 'bearer',
        scope: refreshed.scope ?? currentCreds.scope,
        user_id: refreshed.user_id ?? currentCreds.user_id,
      };

      const encrypted = this.encryption.encryptJson(newCredentials);
      const expiresAt = new Date(
        Date.now() +
          ((refreshed.expires_in as number | undefined) ?? 21600) * 1000,
      );

      await tx.$executeRaw`
        UPDATE "tenant_integrations"
        SET "credentials_encrypted" = ${encrypted},
            "expires_at" = ${expiresAt},
            "status" = 'ACTIVE',
            "updated_at" = NOW()
        WHERE "id" = ${lockedRow.id}
      `;

      return refreshed.access_token;
    });
  }

  /**
   * Executa a chamada HTTP para rotação do refresh token de uso único.
   */
  async executeRefreshTokenRotation(currentRefreshToken: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type?: string;
    scope?: string;
    user_id?: number;
  }> {
    if (!this.clientId || !this.clientSecret) {
      // Modo simulado para dev/testes
      return {
        access_token: `APP_USR-rotated-${randomBytes(12).toString('hex')}`,
        refresh_token: `TG-rotated-${randomBytes(12).toString('hex')}`,
        expires_in: 21600,
        token_type: 'bearer',
      };
    }

    const tokenUrl = `${this.apiBaseUrl}/oauth/token`;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: currentRefreshToken,
    });

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(
        `Falha ao renovar refresh token Mercado Livre: HTTP ${res.status} — ${err}`,
      );
      throw new ServiceUnavailableException(
        `Erro ao renovar sessão do Mercado Livre: ${res.statusText}`,
      );
    }

    return (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type?: string;
      scope?: string;
      user_id?: number;
    };
  }

  /**
   * Consulta os dados de um pedido pelo ID na API do Mercado Livre.
   */
  async getOrder(
    orderId: string,
    tenantId = 'default',
  ): Promise<MeliOrderPayload> {
    const accessToken = await this.getValidAccessToken(tenantId);

    if (!this.clientId || !this.clientSecret) {
      // Simulação para dev/test
      return {
        id: Number.parseInt(orderId, 10) || 20000012345,
        status: 'paid',
        date_created: new Date().toISOString(),
        total_amount: 159.9,
        shipping_cost: 0,
        order_items: [
          {
            item: {
              id: 'MLB999000111',
              title: 'Camiseta Básica Oversized',
              variation_id: 178239,
            },
            quantity: 1,
            unit_price: 159.9,
          },
        ],
        buyer: {
          id: 123456,
          nickname: 'COMPRADOR_ML',
          first_name: 'Ana',
          last_name: 'Souza',
          email: 'ana.souza@mercadolivre.test',
        },
        shipping: {
          receiver_address: {
            street_name: 'Av. Paulista',
            street_number: '1000',
            city: { name: 'São Paulo' },
            state: { name: 'SP' },
            zip_code: '01310-100',
          },
        },
      };
    }

    const res = await fetch(`${this.apiBaseUrl}/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      throw new NotFoundException(
        `Pedido ${orderId} não encontrado no Mercado Livre.`,
      );
    }

    return (await res.json()) as MeliOrderPayload;
  }

  /**
   * Consulta os dados de um item/anúncio na API do Mercado Livre.
   */
  async getItem(
    itemId: string,
    tenantId = 'default',
  ): Promise<MeliItemPayload> {
    const accessToken = await this.getValidAccessToken(tenantId);

    if (!this.clientId || !this.clientSecret) {
      return {
        id: itemId,
        title: 'Produto Simulado ML',
        price: 129.9,
        available_quantity: 15,
        status: 'active',
      };
    }

    const res = await fetch(`${this.apiBaseUrl}/items/${itemId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      throw new NotFoundException(
        `Item ${itemId} não encontrado no Mercado Livre.`,
      );
    }

    return (await res.json()) as MeliItemPayload;
  }

  /**
   * Atualiza a quantidade de estoque de um anúncio ou variante no Mercado Livre.
   */
  async updateItemStock(
    itemId: string,
    variationId: string | null,
    stock: number,
    tenantId = 'default',
  ): Promise<void> {
    const accessToken = await this.getValidAccessToken(tenantId);

    if (!this.clientId || !this.clientSecret) {
      this.logger.log(
        `[Simulado ML] Estoque atualizado para item ${itemId} (var: ${variationId ?? 'único'}): ${stock} un.`,
      );
      return;
    }

    const url =
      variationId && variationId !== ''
        ? `${this.apiBaseUrl}/items/${itemId}/variations/${variationId}`
        : `${this.apiBaseUrl}/items/${itemId}`;

    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ available_quantity: Math.max(0, stock) }),
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(
        `Falha ao atualizar estoque no Mercado Livre (item: ${itemId}): HTTP ${res.status} — ${err}`,
      );
      throw new InternalServerErrorException(
        `Erro ao sincronizar estoque no Mercado Livre: ${res.statusText}`,
      );
    }
  }

  /**
   * Publica ou sincroniza um produto do catálogo local no Mercado Livre.
   */
  async publishItem(
    input: MeliPublishItemInput,
    tenantId = 'default',
  ): Promise<{
    itemId: string;
    variationMappings: Array<{
      variantId: string;
      externalVariationId: string;
    }>;
  }> {
    const accessToken = await this.getValidAccessToken(tenantId);

    if (!this.clientId || !this.clientSecret) {
      const simulatedItemId = `MLB${randomBytes(4).toString('hex').toUpperCase()}`;
      return {
        itemId: simulatedItemId,
        variationMappings: input.variations.map((v, idx) => ({
          variantId: v.variantId,
          externalVariationId: `VAR_${simulatedItemId}_${String(idx + 1)}`,
        })),
      };
    }

    // Chamada real POST /items
    const meliPayload = {
      title: input.title.slice(0, 60), // ML limita a 60 caracteres
      category_id: 'MLB1051', // Categoria vestuário padrão
      price: input.priceCents / 100,
      currency_id: 'BRL',
      available_quantity: input.variations.reduce(
        (sum, v) => sum + v.stockQuantity,
        0,
      ),
      buying_mode: 'buy_it_now',
      listing_type_id: 'gold_special',
      condition: 'new',
      pictures: input.imageUrls.map((source) => ({ source })),
    };

    const res = await fetch(`${this.apiBaseUrl}/items`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(meliPayload),
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(
        `Falha ao publicar produto no ML: HTTP ${res.status} — ${err}`,
      );
      throw new InternalServerErrorException(
        `Erro ao publicar produto no Mercado Livre.`,
      );
    }

    const created = (await res.json()) as { id: string };

    return {
      itemId: created.id,
      variationMappings: input.variations.map((v, idx) => ({
        variantId: v.variantId,
        externalVariationId: `VAR_${created.id}_${String(idx + 1)}`,
      })),
    };
  }
}
