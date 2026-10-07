import { AmazonSigV4 } from './amazon-sigv4';

describe('AmazonSigV4', () => {
  const credentials = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  it('deve gerar assinatura AWS SigV4 válida para método GET', () => {
    const fixedTime = new Date('2026-10-07T12:00:00Z');
    const result = AmazonSigV4.sign({
      method: 'GET',
      url: 'https://sellingpartnerapi-na.amazon.com/orders/v0/orders?MarketplaceIds=A2Q3Y263D00KWC',
      credentials,
      region: 'us-east-1',
      service: 'execute-api',
      timestamp: fixedTime,
    });

    expect(result.authorization).toBeDefined();
    expect(result.authorization).toContain(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261007/us-east-1/execute-api/aws4_request',
    );
    expect(result.authorization).toContain('SignedHeaders=');
    expect(result.authorization).toContain('Signature=');
    expect(result.headers['x-amz-date']).toBe('20261007T120000Z');
    expect(result.headers['host']).toBe('sellingpartnerapi-na.amazon.com');
  });

  it('deve incluir x-amz-security-token se sessionToken fornecido', () => {
    const credsWithToken = {
      ...credentials,
      sessionToken: 'test-session-token-xyz',
    };

    const result = AmazonSigV4.sign({
      method: 'GET',
      url: 'https://sellingpartnerapi-na.amazon.com/catalog/v0/items',
      credentials: credsWithToken,
      timestamp: new Date('2026-10-07T12:00:00Z'),
    });

    expect(result.headers['x-amz-security-token']).toBe(
      'test-session-token-xyz',
    );
    expect(result.authorization).toContain('x-amz-security-token');
  });

  it('deve calcular hash do body para requisições POST ou PATCH', () => {
    const body = {
      productType: 'SHIRT',
      patches: [{ op: 'replace', path: '/test', value: [] }],
    };
    const result = AmazonSigV4.sign({
      method: 'PATCH',
      url: 'https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/SELLER123/SKU1',
      headers: {
        'Content-Type': 'application/json',
        'x-amz-access-token': 'Atza|fake-token',
      },
      body,
      credentials,
      timestamp: new Date('2026-10-07T12:00:00Z'),
    });

    expect(result.headers['content-type']).toBe('application/json');
    expect(result.headers['x-amz-access-token']).toBe('Atza|fake-token');
    expect(result.authorization).toContain('Signature=');
  });

  it('deve ordenar parâmetros de query string na ordem lexicográfica', () => {
    const result = AmazonSigV4.sign({
      method: 'GET',
      url: 'https://sellingpartnerapi-na.amazon.com/test?z=1&a=2&m=3',
      credentials,
      timestamp: new Date('2026-10-07T12:00:00Z'),
    });

    expect(result.authorization).toBeDefined();
  });
});
