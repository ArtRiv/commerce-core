import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../crypto/encryption.service';

export interface OAuthStatePayload {
  tenantId: string;
  nonce: string;
  timestamp: number;
  sig: string;
}

export interface MeliTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  user_id: number;
  refresh_token: string;
  user_nickname?: string;
}

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutos

@Injectable()
export class MercadoLivreAuthService {
  private readonly logger = new Logger(MercadoLivreAuthService.name);
  private readonly secret: string;
  private readonly clientId: string | null;
  private readonly clientSecret: string | null;
  private readonly redirectUri: string;
  private readonly authBaseUrl: string;
  private readonly apiBaseUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {
    this.secret =
      this.config.get<string>('MERCADO_LIVRE_STATE_SECRET') ??
      this.config.get<string>('JWT_SECRET') ??
      'meli-state-secret-fallback';

    this.clientId =
      this.config.get<string>('MERCADO_LIVRE_CLIENT_ID')?.trim() ?? null;
    this.clientSecret =
      this.config.get<string>('MERCADO_LIVRE_CLIENT_SECRET')?.trim() ?? null;

    const apiUrl =
      this.config.get<string>('API_URL') ?? 'http://localhost:3000';
    this.redirectUri =
      this.config.get<string>('MERCADO_LIVRE_REDIRECT_URI') ??
      `${apiUrl}/integrations/mercadolivre/callback`;

    this.authBaseUrl =
      this.config.get<string>('MERCADO_LIVRE_AUTH_URL') ??
      'https://auth.mercadolivre.com.br/authorization';
    this.apiBaseUrl =
      this.config.get<string>('MERCADO_LIVRE_API_URL') ??
      'https://api.mercadolibre.com';
  }

  /**
   * Gera o parâmetro `state` criptograficamente assinado com HMAC-SHA256
   * para prevenir ataques de falsificação de solicitação entre sites (CSRF).
   *
   * Formato: Base64URL(JSON({ tenantId, nonce, timestamp, sig }))
   */
  generateState(tenantId = 'default'): string {
    const nonce = randomBytes(16).toString('hex');
    const timestamp = Date.now();
    const message = `${tenantId}:${nonce}:${timestamp}`;
    const sig = createHmac('sha256', this.secret).update(message).digest('hex');

    const payload: OAuthStatePayload = {
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
      const payload = JSON.parse(decoded) as OAuthStatePayload;

      if (
        !payload.tenantId ||
        !payload.nonce ||
        !payload.timestamp ||
        !payload.sig
      ) {
        throw new BadRequestException('State de autenticação OAuth inválido.');
      }

      // Validação de expiração (TTL de 10 minutos)
      const now = Date.now();
      if (
        now - payload.timestamp > STATE_TTL_MS ||
        payload.timestamp > now + 60_000
      ) {
        throw new BadRequestException('State de autenticação OAuth expirado.');
      }

      // Validação de assinatura em tempo constante (timingSafeEqual)
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
        throw new BadRequestException('Assinatura do state OAuth inválida.');
      }

      return { tenantId: payload.tenantId };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        'Falha ao decodificar state de autenticação.',
      );
    }
  }

  /**
   * Constrói a URL do Mercado Livre para onde o lojista será redirecionado
   * ao conectar o marketplace no painel admin.
   */
  getAuthorizationUrl(tenantId = 'default'): string {
    const state = this.generateState(tenantId);
    const clientId = this.clientId ?? 'mock-meli-client-id';

    const url = new URL(this.authBaseUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('state', state);

    return url.toString();
  }

  /**
   * Troca o Authorization Code por Access Token e Refresh Token,
   * salvando as credenciais encriptadas com AES-256-GCM na tabela `tenant_integrations`.
   */
  async exchangeAuthorizationCode(
    code: string,
    state: string,
  ): Promise<{ tenantId: string; nickname: string }> {
    const { tenantId } = this.verifyState(state);

    let tokenData: MeliTokenResponse;

    // Se as credenciais do app ML não estiverem configuradas no ambiente,
    // opera em modo simulado para dev/testes automatizados
    if (!this.clientId || !this.clientSecret) {
      this.logger.warn(
        'MERCADO_LIVRE_CLIENT_ID ou SECRET não configurados — utilizando credenciais simuladas.',
      );
      tokenData = {
        access_token: `APP_USR-simulated-${randomBytes(12).toString('hex')}`,
        token_type: 'bearer',
        expires_in: 21600, // 6 horas
        scope: 'offline_access read write',
        user_id: 99887766,
        refresh_token: `TG-simulated-${randomBytes(12).toString('hex')}`,
        user_nickname: 'LOJA_DEMO_ML',
      };
    } else {
      tokenData = await this.fetchTokensFromMeli(code);
    }

    const encryptedCredentials = this.encryption.encryptJson({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_type: tokenData.token_type,
      scope: tokenData.scope,
      user_id: tokenData.user_id,
    });

    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
    const nickname =
      tokenData.user_nickname ?? `Vendedor ML #${tokenData.user_id}`;

    await this.prisma.tenantIntegration.upsert({
      where: {
        tenantId_provider: {
          tenantId,
          provider: 'MERCADO_LIVRE',
        },
      },
      create: {
        tenantId,
        provider: 'MERCADO_LIVRE',
        credentialsEncrypted: encryptedCredentials,
        status: 'ACTIVE',
        expiresAt,
        metadata: {
          userId: tokenData.user_id,
          nickname,
          connectedAt: new Date().toISOString(),
        },
      },
      update: {
        credentialsEncrypted: encryptedCredentials,
        status: 'ACTIVE',
        expiresAt,
        metadata: {
          userId: tokenData.user_id,
          nickname,
          connectedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      },
    });

    return { tenantId, nickname };
  }

  private async fetchTokensFromMeli(code: string): Promise<MeliTokenResponse> {
    const tokenUrl = `${this.apiBaseUrl}/oauth/token`;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.clientId ?? '',
      client_secret: this.clientSecret ?? '',
      code,
      redirect_uri: this.redirectUri,
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errText = await response.text();
      this.logger.error(
        `Mercado Livre OAuth token exchange falhou: HTTP ${response.status} — ${errText}`,
      );
      throw new BadRequestException(
        `Falha na autorização com o Mercado Livre: ${response.statusText}`,
      );
    }

    const json = (await response.json()) as MeliTokenResponse;

    // Tenta obter o nickname do vendedor
    try {
      const userRes = await fetch(`${this.apiBaseUrl}/users/${json.user_id}`, {
        headers: { Authorization: `Bearer ${json.access_token}` },
      });
      if (userRes.ok) {
        const userJson = (await userRes.json()) as { nickname?: string };
        json.user_nickname = userJson.nickname;
      }
    } catch {
      // Ignora erro opcional de busca do nickname
    }

    return json;
  }
}
