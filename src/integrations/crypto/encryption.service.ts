import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Serviço de criptografia simétrica autenticada em repouso utilizando AES-256-GCM.
 *
 * Utilizado para cifrar tokens de acesso e refresh tokens de marketplaces
 * na tabela `tenant_integrations`. Cada cifra produz um IV aleatório de 12 bytes
 * e uma tag de autenticação GCM de 16 bytes, prevenindo ataques de adulteração (tampering)
 * e reutilização de chave.
 */
@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const rawKey = config.get<string>('APP_ENCRYPTION_KEY')?.trim();

    if (!rawKey) {
      const nodeEnv = config.get<string>('NODE_ENV') ?? 'development';
      if (nodeEnv !== 'development' && nodeEnv !== 'test') {
        throw new InternalServerErrorException(
          'APP_ENCRYPTION_KEY obrigatória em produção para criptografia em repouso de credenciais multi-tenant.',
        );
      }
      this.logger.warn(
        'APP_ENCRYPTION_KEY não configurada — utilizando chave de desenvolvimento derivada do JWT_SECRET.',
      );
      const secret =
        config.get<string>('JWT_SECRET') ??
        'dev-encryption-fallback-secret-256';
      this.key = createHash('sha256').update(secret).digest();
    } else {
      // Normaliza para 32 bytes (256 bits): se for hex (64 chars) converte direto, senão faz hash SHA-256
      if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
        this.key = Buffer.from(rawKey, 'hex');
      } else {
        this.key = createHash('sha256').update(rawKey).digest();
      }
    }
  }

  /**
   * Cifra um texto em formato utf-8 e retorna a string no formato:
   * `<iv_hex>:<tag_hex>:<ciphertext_hex>`
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);

    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
  }

  /**
   * Decifra uma string no formato `<iv_hex>:<tag_hex>:<ciphertext_hex>`.
   * Lança erro caso o texto tenha sido adulterado, tag inválida ou chave incorreta.
   */
  decrypt(payload: string): string {
    const parts = payload.split(':');
    if (parts.length !== 3) {
      throw new InternalServerErrorException(
        'Formato de cifra inválido — esperado iv:tag:ciphertext.',
      );
    }

    const [ivHex, tagHex, cipherHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const ciphertext = Buffer.from(cipherHex, 'hex');

    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);

      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);

      return decrypted.toString('utf8');
    } catch {
      throw new InternalServerErrorException(
        'Falha ao decifrar credencial: integridade violada ou chave de criptografia incorreta.',
      );
    }
  }

  /**
   * Cifra um objeto serializável em JSON.
   */
  encryptJson(data: unknown): string {
    return this.encrypt(JSON.stringify(data));
  }

  /**
   * Decifra e desserializa um JSON para o tipo esperado.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  decryptJson<T>(payload: string): T {
    const jsonStr = this.decrypt(payload);
    return JSON.parse(jsonStr) as T;
  }
}
