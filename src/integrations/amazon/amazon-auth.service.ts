import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../crypto/encryption.service';
import { AMAZON_BR_MARKETPLACE_ID } from './amazon-catalog-mapping.service';

export interface AmazonOAuthStatePayload {
  tenantId: string;
  nonce: string;
  timestamp: number;
  sig: string;
}

export interface LwaTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

export interface StoredAmazonCredentials {
  access_token: string;
  refresh_token: string;
  selling_partner_id: string;
  marketplace_id: string;
  client_id?: string;
}

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutos

/**
 * Serviço de autenticação Login with Amazon (LWA) para a Selling Partner API (SP-API).
 *
 * Cuida do handshake OAuth 2.0 seguro com mitigação timing-safe de CSRF,
 * troca do spapi_oauth_code por tokens LWA e armazenamento simetricamente
 * criptografado com AES-256-GCM na tabela `tenant_integrations`.
 */
@Injectable()
export class AmazonAuthService {
  private readonly logger = new Logger(AmazonAuthService.name);
  private readonly secret: string;
  private readonly appId: string | null;
  private readonly clientId: string | null;
  private readonly clientSecret: string | null;
  private readonly sellerCentralUrl: string;
  private readonly lwaTokenUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {
    this.secret =
      this.config.get<string>('AMAZON_STATE_SECRET') ??
      this.config.get<string>('JWT_SECRET') ??
      'amazon-spapi-state-secret-fallback';

    this.appId = this.config.get<string>('AMAZON_APP_ID')?.trim() ?? null;
    this.clientId = this.config.get<string>('AMAZON_CLIENT_ID')?.trim() ?? null;
    this.clientSecret =
      this.config.get<string>('AMAZON_CLIENT_SECRET')?.trim() ?? null;

    this.sellerCentralUrl =
      this.config.get<string>('AMAZON_SELLER_CENTRAL_URL') ??
      'https://sellercentral.amazon.com.br/apps/authorize/consent';

    this.lwaTokenUrl =
      this.config.get<string>('AMAZON_LWA_TOKEN_URL') ??
      'https://api.amazon.com/auth/o2/token';
  }

  /**
   * Gera o parâmetro `state` criptograficamente assinado com HMAC-SHA256
   * para prevenir ataques de falsificação de solicitação entre sites (CSRF).
   */
  generateState(tenantId = 'default'): string {
    const nonce = randomBytes(16).toString('hex');
    const timestamp = Date.now();
    const message = `${tenantId}:${nonce}:${timestamp}`;
    const sig = createHmac('sha256', this.secret).update(message).digest('hex');

    const payload: AmazonOAuthStatePayload = {
      tenantId,
      nonce,
      timestamp,
      sig,
    };

    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  /**
   * Valida a assinatura e a validade temporal do `state`.
   */
  verifyState(state: string): { tenantId: string } {
    try {
      const decoded = Buffer.from(state, 'base64url').toString('utf8');
      const payload = JSON.parse(decoded) as AmazonOAuthStatePayload;

      if (
        !payload.tenantId ||
        !payload.nonce ||
        !payload.timestamp ||
        !payload.sig
      ) {
        throw new BadRequestException(
          'State de autenticação da Amazon inválido.',
        );
      }

      const now = Date.now();
      if (
        now - payload.timestamp > STATE_TTL_MS ||
        payload.timestamp > now + 60_000
      ) {
        throw new BadRequestException(
          'State de autenticação da Amazon expirado.',
        );
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
        throw new BadRequestException(
          'Assinatura do state da Amazon inválida.',
        );
      }

      return { tenantId: payload.tenantId };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        'Falha ao decodificar state de autorização da Amazon.',
      );
    }
  }

  /**
   * Monta a URL do Seller Central da Amazon para início do fluxo de consentimento.
   */
  getAuthorizationUrl(tenantId = 'default'): string {
    const state = this.generateState(tenantId);
    const appId = this.appId ?? 'amzn1.sp.solution.simulated-avesso-app';

    const url = new URL(this.sellerCentralUrl);
    url.searchParams.set('application_id', appId);
    url.searchParams.set('state', state);
    url.searchParams.set('version', 'beta');

    return url.toString();
  }

  /**
   * Troca o spapi_oauth_code por Access Token e Refresh Token LWA e salva
   * no banco de dados com criptografia AES-256-GCM.
   */
  async exchangeAuthorizationCode(
    code: string,
    sellingPartnerId: string,
    state: string,
  ): Promise<{
    tenantId: string;
    sellingPartnerId: string;
    marketplaceId: string;
  }> {
    const { tenantId } = this.verifyState(state);

    let tokenData: LwaTokenResponse;

    if (!this.clientId || !this.clientSecret) {
      this.logger.warn(
        'AMAZON_CLIENT_ID ou SECRET não configurados — utilizando credenciais LWA simuladas.',
      );
      tokenData = {
        access_token: `Atza|simulated-${randomBytes(24).toString('hex')}`,
        refresh_token: `Atzr|simulated-${randomBytes(24).toString('hex')}`,
        token_type: 'bearer',
        expires_in: 3600, // 1 hora padrão LWA
      };
    } else {
      tokenData = await this.fetchTokensFromLwa(code);
    }

    const credentialsToStore: StoredAmazonCredentials = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      selling_partner_id: sellingPartnerId,
      marketplace_id: AMAZON_BR_MARKETPLACE_ID,
      client_id: this.clientId ?? undefined,
    };

    const encryptedCredentials =
      this.encryption.encryptJson(credentialsToStore);

    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

    await this.prisma.tenantIntegration.upsert({
      where: {
        tenantId_provider: {
          tenantId,
          provider: 'AMAZON',
        },
      },
      create: {
        tenantId,
        provider: 'AMAZON',
        credentialsEncrypted: encryptedCredentials,
        status: 'ACTIVE',
        expiresAt,
        metadata: {
          sellingPartnerId,
          marketplaceId: AMAZON_BR_MARKETPLACE_ID,
          dppCompliant: true,
          connectedAt: new Date().toISOString(),
        },
      },
      update: {
        credentialsEncrypted: encryptedCredentials,
        status: 'ACTIVE',
        expiresAt,
        metadata: {
          sellingPartnerId,
          marketplaceId: AMAZON_BR_MARKETPLACE_ID,
          dppCompliant: true,
          connectedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      },
    });

    this.logger.log(
      `Integração Amazon SP-API conectada para seller ${sellingPartnerId} no tenant ${tenantId}.`,
    );

    return {
      tenantId,
      sellingPartnerId,
      marketplaceId: AMAZON_BR_MARKETPLACE_ID,
    };
  }

  private async fetchTokensFromLwa(code: string): Promise<LwaTokenResponse> {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.clientId ?? '',
      client_secret: this.clientSecret ?? '',
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
      this.logger.error(`Erro ao obter tokens LWA da Amazon: ${errText}`);
      throw new BadRequestException(
        `Falha na autenticação LWA com a Amazon (HTTP ${response.status}).`,
      );
    }

    return (await response.json()) as LwaTokenResponse;
  }
}
