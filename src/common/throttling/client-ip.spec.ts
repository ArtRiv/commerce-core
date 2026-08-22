import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { clientIpFrom, resolveClientIpHeader } from './client-ip';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function requestWith(
  headers: Record<string, string | string[] | undefined>,
  ip?: string,
): Request {
  return { headers, ip } as unknown as Request;
}

describe('resolveClientIpHeader', () => {
  it('is null when unset — req.ip stays the key', () => {
    expect(resolveClientIpHeader(configWith({}))).toBeNull();
  });

  it('is null when blank', () => {
    expect(resolveClientIpHeader(configWith({ CLIENT_IP_HEADER: '   ' }))).toBe(
      null,
    );
  });

  it('lowercases the name, because Node lowercases header keys', () => {
    expect(
      resolveClientIpHeader(
        configWith({ CLIENT_IP_HEADER: 'CF-Connecting-IP' }),
      ),
    ).toBe('cf-connecting-ip');
  });

  it('trims surrounding whitespace', () => {
    expect(
      resolveClientIpHeader(
        configWith({ CLIENT_IP_HEADER: ' true-client-ip ' }),
      ),
    ).toBe('true-client-ip');
  });

  it.each(['has space', 'semi;colon', 'nÃo-ascii', 'with:colon', 'quote"d'])(
    'refuses %s as a header name',
    (value) => {
      expect(() =>
        resolveClientIpHeader(configWith({ CLIENT_IP_HEADER: value })),
      ).toThrow(/CLIENT_IP_HEADER/);
    },
  );

  it('names the offending value', () => {
    expect(() =>
      resolveClientIpHeader(configWith({ CLIENT_IP_HEADER: 'bad header' })),
    ).toThrow(/"bad header"/);
  });
});

describe('clientIpFrom', () => {
  it('falls back to req.ip when no header is configured', () => {
    expect(clientIpFrom(requestWith({}, '203.0.113.5'), null)).toBe(
      '203.0.113.5',
    );
  });

  it('ignores the header entirely when none is configured', () => {
    // The header may well be present; without configuration it is just another
    // string a caller can write, and must not influence the key.
    expect(
      clientIpFrom(
        requestWith({ 'cf-connecting-ip': '1.2.3.4' }, '203.0.113.5'),
        null,
      ),
    ).toBe('203.0.113.5');
  });

  it('reads the configured header when present', () => {
    expect(
      clientIpFrom(
        requestWith({ 'cf-connecting-ip': '198.51.100.9' }, '10.0.0.1'),
        'cf-connecting-ip',
      ),
    ).toBe('198.51.100.9');
  });

  it('takes the first entry if the header ever carries a list', () => {
    expect(
      clientIpFrom(
        requestWith(
          { 'cf-connecting-ip': '198.51.100.9, 10.0.0.7' },
          '10.0.0.1',
        ),
        'cf-connecting-ip',
      ),
    ).toBe('198.51.100.9');
  });

  it('takes the first value if the header is repeated', () => {
    expect(
      clientIpFrom(
        requestWith({ 'cf-connecting-ip': ['198.51.100.9', '10.0.0.7'] }),
        'cf-connecting-ip',
      ),
    ).toBe('198.51.100.9');
  });

  it('falls back to req.ip when the configured header is absent', () => {
    // Reaching the origin without going through the edge that sets the header.
    // Falling back is deliberate: the alternative is one key for every such
    // request, which would rate-limit the whole world together.
    expect(
      clientIpFrom(requestWith({}, '203.0.113.5'), 'cf-connecting-ip'),
    ).toBe('203.0.113.5');
  });

  it('falls back when the header is present but empty', () => {
    expect(
      clientIpFrom(
        requestWith({ 'cf-connecting-ip': '  ' }, '203.0.113.5'),
        'cf-connecting-ip',
      ),
    ).toBe('203.0.113.5');
  });

  it('degrades to a constant only when there is nothing at all', () => {
    expect(clientIpFrom(requestWith({}), 'cf-connecting-ip')).toBe('unknown');
  });
});
