import { toCount, toInstant } from './aggregates';

describe('toCount', () => {
  it('reads the bigint every SUM in this module casts to', () => {
    expect(toCount(1234n)).toBe(1234);
    expect(toCount(0n)).toBe(0);
  });

  it('reads the string form the driver may hand back instead', () => {
    expect(toCount('1234')).toBe(1234);
  });

  it('passes a plain number through', () => {
    expect(toCount(7)).toBe(7);
  });

  // A SUM over no rows is null. Zero is its only sensible reading, and the
  // queries COALESCE anyway — this is the second belt.
  it('reads an empty aggregate as zero', () => {
    expect(toCount(null)).toBe(0);
    expect(toCount(undefined)).toBe(0);
  });

  /**
   * The reason this function exists rather than a bare Number(). Money is
   * integer cents and must never arrive rounded — 2^53 cents is ninety
   * trillion reais, so crossing it means something is wrong upstream, not
   * that the store had a good year.
   */
  it('refuses a value too large to be exact', () => {
    expect(() => toCount(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(
      /exact/i,
    );
  });

  it('refuses anything it cannot read as an integer', () => {
    expect(() => toCount('R$ 12,00')).toThrow();
    expect(() => toCount({})).toThrow();
    expect(() => toCount(1.5)).toThrow();
  });
});

describe('toInstant', () => {
  /**
   * Timestamps come back from these queries as explicit UTC text, parsed
   * here rather than by the driver: node-postgres reads a `timestamp without
   * time zone` through the process's own offset, which would shift every
   * date by however the server happens to be configured.
   */
  it('parses the UTC text the queries format', () => {
    expect(toInstant('2026-08-01T03:04:05.678Z')).toEqual(
      new Date('2026-08-01T03:04:05.678Z'),
    );
  });

  it('reads never-sold as null', () => {
    expect(toInstant(null)).toBeNull();
    expect(toInstant(undefined)).toBeNull();
  });

  it('refuses text it cannot parse', () => {
    expect(() => toInstant('someday')).toThrow();
  });
});
