import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../crypto/encryption.service';

export interface ShopeeOAuthStatePayload {
  tenantId: string;
  nonce: string;
  timestamp: number;
  sig: string;
}

export interface ShopeeTokenResponse {
  access_token: string;
  refresh_token: string;
  expire_in: number; // segundos (normalmente 14400 = 4h)
  shop_id: number;
  merchant_id_list?: number[];
  shop_name?: string;
}

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutos

@Injectable()
export class ShopeeAuthService {
  private readonly logger = new Logger(ShopeeAuthService.name);
  private readonly secret: string;
  private readonly partnerId: number | null;
  private readonly partnerKey: string | null;
  private readonly redirectUri: string;
  private readonly apiBaseUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {
    this.secret =
      this.config.get<string>('SHOPEE_STATE_SECRET') ??
      this.config.get<string>('JWT_SECRET') ??
      'shopee-state-secret-fallback';

    const pId = this.config.get<string>('SHOPEE_PARTNER_ID')?.trim();
    this.partnerId = pId ? Number.parseInt(pId, 10) : null;
    this.partnerKey =
      this.config.get<string>('SHOPEE_PARTNER_KEY')?.trim() ?? null;

    const apiUrl =
      this.config.get<string>('API_URL') ?? 'http://localhost:3000';
    this.redirectUri =
      this.config.get<string>('SHOPEE_REDIRECT_URI') ??
      `${apiUrl}/integrations/shopee/callback`;

    this.apiBaseUrl =
      this.config.get<string>('SHOPEE_API_URL') ??
      'https://partner.shopeemobile.com';
  }

  /**
   * Calcula a assinatura HMAC-SHA256 para APIs públicas da Shopee (como autenticação).
   * Fórmula oficial Shopee: base_string = partner_id + path + timestamp
   */
  generatePublicSignature(path: string, timestamp: number): string {
    const key = this.partnerKey ?? 'mock-shopee-partner-key';
    const partnerId = this.partnerId ?? 123456;
    const baseString = `${partnerId}${path}${timestamp}`;
    return createHmac('sha256', key).update(baseString).digest('hex');
  }

  /**
   * Gera o parâmetro `state` assinado com HMAC-SHA256 para prevenção de ataques CSRF.
   */
  generateState(tenantId = 'default'): string {
    const nonce = randomBytes(16).toString('hex');
    const timestamp = Date.now();
    const message = `${tenantId}:${nonce}:${timestamp}`;
    const sig = createHmac('sha256', this.secret).update(message).digest('hex');

    const payload: ShopeeOAuthStatePayload = {
      tenantId,
      nonce,
      timestamp,
      sig,
    };

    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  /**
   * Valida a assinatura criptográfica e a validade temporal do `state`.
   */
  verifyState(state: string): { tenantId: string } {
    try {
      const decoded = Buffer.from(state, 'base64url').toString('utf8');
      const payload = JSON.parse(decoded) as ShopeeOAuthStatePayload;

      if (
        !payload.tenantId ||
        !payload.nonce ||
        !payload.timestamp ||
        !payload.sig
      ) {
        throw new BadRequestException('State de autenticação Shopee inválido.');
      }

      const now = Date.now();
      if (
        now - payload.timestamp > STATE_TTL_MS ||
        payload.timestamp > now + 60_000
      ) {
        throw new BadRequestException('State de autenticação Shopee expirado.');
      }

      const expectedMessage = `${payload.tenantId}:${payload.nonce}:${payload.timestamp}`;
      const expectedSig = createHmac('sha256', this.secret)
        .update(expectedMessage)
        .digest('hex');

      const sigBuf = Buffer.from(payload.sig, 'hex');
      const expectedSigBuf = Buffer.from(expectedSig, 'hex');

      if (
        sigBuf.length !== expectedSigBuf.length ||
        !timingSafeEqual(sigBuf, expectedSigBuf)
      ) {
        throw new BadRequestException('Assinatura do state Shopee inválida.');
      }

      return { tenantId: payload.tenantId };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        'Falha ao decodificar state de autenticação da Shopee.',
      );
    }
  }

  /**
   * Constrói a URL de autorização da Shopee Open Platform (/api/v2/shop/auth_partner).
   */
  getAuthorizationUrl(tenantId = 'default'): string {
    const state = this.generateState(tenantId);
    const partnerId = this.partnerId ?? 123456;
    const path = '/api/v2/shop/auth_partner';
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = this.generatePublicSignature(path, timestamp);

    const redirectWithState = new URL(this.redirectUri);
    redirectWithState.searchParams.set('state', state);

    const url = new URL(`${this.apiBaseUrl}${path}`);
    url.searchParams.set('partner_id', String(partnerId));
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('sign', sign);
    url.searchParams.set('redirect', redirectWithState.toString());

    return url.toString();
  }

  /**
   * Troca o Authorization Code retornado pela Shopee por Access Token e Refresh Token,
   * persistindo as credenciais encriptadas com AES-256-GCM em `tenant_integrations`.
   */
  async exchangeAuthorizationCode(
    code: string,
    shopId: number,
    state?: string,
  ): Promise<{ tenantId: string; shopId: number; shopName: string }> {
    let tenantId = 'default';
    if (state) {
      tenantId = this.verifyState(state).tenantId;
    }

    let tokenData: ShopeeTokenResponse;

    if (!this.partnerId || !this.partnerKey) {
      this.logger.warn(
        'SHOPEE_PARTNER_ID ou SHOPEE_PARTNER_KEY não configurados — utilizando credenciais simuladas.',
      );
      tokenData = {
        access_token: `shopee_simulated_acc_${randomBytes(12).toString('hex')}`,
        refresh_token: `shopee_simulated_ref_${randomBytes(12).toString('hex')}`,
        expire_in: 14400, // 4 horas
        shop_id: shopId || 654321,
        shop_name: 'Loja Oficial Shopee',
      };
    } else {
      tokenData = await this.fetchTokensFromShopee(code, shopId);
    }

    const encryptedCredentials = this.encryption.encryptJson({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expire_in: tokenData.expire_in,
      shop_id: tokenData.shop_id,
    });

    const expiresAt = new Date(Date.now() + tokenData.expire_in * 1000);
    const shopName = tokenData.shop_name ?? `Loja Shopee #${tokenData.shop_id}`;

    await this.prisma.tenantIntegration.upsert({
      where: {
        tenantId_provider: {
          tenantId,
          provider: 'SHOPEE',
        },
      },
      create: {
        tenantId,
        provider: 'SHOPEE',
        credentialsEncrypted: encryptedCredentials,
        status: 'ACTIVE',
        expiresAt,
        metadata: {
          shopId: tokenData.shop_id,
          shopName,
          connectedAt: new Date().toISOString(),
        },
      },
      update: {
        credentialsEncrypted: encryptedCredentials,
        status: 'ACTIVE',
        expiresAt,
        metadata: {
          shopId: tokenData.shop_id,
          shopName,
          connectedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      },
    });

    return { tenantId, shopId: tokenData.shop_id, shopName };
  }

  private async fetchTokensFromShopee(
    code: string,
    shopId: number,
  ): Promise<ShopeeTokenResponse> {
    const path = '/api/v2/auth/token/get';
    const timestamp = Math.floor(Date.now() / 1000);
    const partnerId = this.partnerId ?? 123456;
    const sign = this.generatePublicSignature(path, timestamp);

    const tokenUrl = new URL(`${this.apiBaseUrl}${path}`);
    tokenUrl.searchParams.set('partner_id', String(partnerId));
    tokenUrl.searchParams.set('timestamp', String(timestamp));
    tokenUrl.searchParams.set('sign', sign);

    const response = await fetch(tokenUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        code,
        partner_id: partnerId,
        shop_id: shopId,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      this.logger.error(
        `Shopee OAuth token exchange falhou: HTTP ${response.status} — ${errText}`,
      );
      throw new BadRequestException(
        `Falha na autorização com a Shopee: ${response.statusText}`,
      );
    }

    const json = (await response.json()) as {
      error?: string;
      message?: string;
      response?: ShopeeTokenResponse;
    };

    if (json.error || !json.response) {
      this.logger.error(
        `Shopee API respondeu com erro de autorização: ${json.error} — ${json.message}`,
      );
      throw new BadRequestException(
        `Erro retornado pela Shopee: ${json.message || json.error}`,
      );
    }

    return json.response;
  }
}
