import { createHash, createHmac } from 'node:crypto';

export interface AwsSigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  credentials: AwsSigV4Credentials;
  region?: string;
  service?: string;
  timestamp?: Date;
}

export interface SignedRequestResult {
  headers: Record<string, string>;
  authorization: string;
}

/**
 * Utilitário para geração de assinaturas AWS Signature Version 4 (SigV4)
 * compatíveis com a Amazon Selling Partner API (SP-API).
 *
 * Utiliza o algoritmo padrão AWS4-HMAC-SHA256 para autenticar requisições REST
 * direcionadas ao serviço execute-api.
 */
export class AmazonSigV4 {
  private static sha256(data: string | Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  private static hmac(key: Buffer | string, data: string): Buffer {
    return createHmac('sha256', key).update(data, 'utf8').digest();
  }

  private static getSignatureKey(
    key: string,
    dateStamp: string,
    regionName: string,
    serviceName: string,
  ): Buffer {
    const kDate = AmazonSigV4.hmac(`AWS4${key}`, dateStamp);
    const kRegion = AmazonSigV4.hmac(kDate, regionName);
    const kService = AmazonSigV4.hmac(kRegion, serviceName);
    return AmazonSigV4.hmac(kService, 'aws4_request');
  }

  /**
   * Assina uma requisição HTTP para a Amazon SP-API gerando os cabeçalhos
   * `x-amz-date`, `Authorization` e opcionalmente `x-amz-security-token`.
   */
  static sign(options: SignRequestOptions): SignedRequestResult {
    const {
      method,
      url: rawUrl,
      credentials,
      region = 'us-east-1',
      service = 'execute-api',
      timestamp = new Date(),
    } = options;

    const parsedUrl = new URL(rawUrl);
    const amzDate = timestamp.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    // Constrói payload hash (SHA256)
    let payload = '';
    if (options.body) {
      payload =
        typeof options.body === 'string'
          ? options.body
          : Buffer.isBuffer(options.body)
            ? options.body.toString('utf8')
            : JSON.stringify(options.body);
    }
    const payloadHash = AmazonSigV4.sha256(payload);

    // Normaliza headers
    const headersToSign: Record<string, string> = {
      host: parsedUrl.host,
      'x-amz-date': amzDate,
    };

    if (credentials.sessionToken) {
      headersToSign['x-amz-security-token'] = credentials.sessionToken;
    }

    if (options.headers) {
      for (const [key, val] of Object.entries(options.headers)) {
        const lowerKey = key.toLowerCase();
        if (lowerKey !== 'authorization') {
          headersToSign[lowerKey] = val.trim();
        }
      }
    }

    // Ordena cabeçalhos assinados
    const sortedHeaderKeys = Object.keys(headersToSign).sort();
    const signedHeaders = sortedHeaderKeys.join(';');
    const canonicalHeaders = sortedHeaderKeys
      .map((k) => `${k}:${headersToSign[k]}\n`)
      .join('');

    // Ordena parâmetros da query string
    const searchParams = Array.from(parsedUrl.searchParams.entries()).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    const canonicalQueryString = searchParams
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    // Canonical Request
    const canonicalUri = parsedUrl.pathname || '/';
    const canonicalRequest = [
      method.toUpperCase(),
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    // String to Sign
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      AmazonSigV4.sha256(canonicalRequest),
    ].join('\n');

    // Calcula chave de assinatura e hash
    const signingKey = AmazonSigV4.getSignatureKey(
      credentials.secretAccessKey,
      dateStamp,
      region,
      service,
    );
    const signature = createHmac('sha256', signingKey)
      .update(stringToSign, 'utf8')
      .digest('hex');

    const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const finalHeaders: Record<string, string> = {
      ...headersToSign,
      Authorization: authorizationHeader,
    };

    return {
      headers: finalHeaders,
      authorization: authorizationHeader,
    };
  }
}
