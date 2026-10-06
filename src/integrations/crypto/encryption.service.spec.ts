import { ConfigService } from '@nestjs/config';

import { EncryptionService } from './encryption.service';

describe('EncryptionService', () => {
  it('cifra e decifra texto com AES-256-GCM preservando o conteúdo original', () => {
    const config = new ConfigService({
      NODE_ENV: 'test',
      APP_ENCRYPTION_KEY: 'a'.repeat(64), // 32 bytes em hex
    });

    const service = new EncryptionService(config);
    const plaintext = 'token-secreto-mercado-livre-12345';

    const encrypted = service.encrypt(plaintext);
    expect(encrypted).not.toEqual(plaintext);
    expect(encrypted.split(':')).toHaveLength(3);

    const decrypted = service.decrypt(encrypted);
    expect(decrypted).toEqual(plaintext);
  });

  it('cifra e decifra objetos JSON corretamente', () => {
    const config = new ConfigService({
      NODE_ENV: 'test',
      APP_ENCRYPTION_KEY: 'b'.repeat(64),
    });

    const service = new EncryptionService(config);
    const credentials = {
      access_token: 'mock-token-99999',
      refresh_token: 'TG-11111',
      expires_in: 21600,
    };

    const encrypted = service.encryptJson(credentials);
    const decrypted = service.decryptJson<typeof credentials>(encrypted);

    expect(decrypted).toEqual(credentials);
  });

  it('lança erro ao tentar decifrar carga corrompida ou adulterada', () => {
    const config = new ConfigService({
      NODE_ENV: 'test',
      APP_ENCRYPTION_KEY: 'c'.repeat(64),
    });

    const service = new EncryptionService(config);
    const encrypted = service.encrypt('mensagem-secreta');

    const parts = encrypted.split(':');
    // Adultera o ciphertext
    const tampered = `${parts[0]}:${parts[1]}:${parts[2].slice(0, -2)}ff`;

    expect(() => service.decrypt(tampered)).toThrow(
      /Falha ao decifrar credencial/,
    );
  });

  it('lança erro para formato inválido de cifra', () => {
    const config = new ConfigService({
      NODE_ENV: 'test',
      APP_ENCRYPTION_KEY: 'd'.repeat(64),
    });

    const service = new EncryptionService(config);
    expect(() => service.decrypt('invalido')).toThrow(
      /Formato de cifra inválido/,
    );
  });
});
