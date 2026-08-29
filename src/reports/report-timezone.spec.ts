import { DEFAULT_TIME_ZONE, resolveTimeZone } from './report-timezone';

describe('resolveTimeZone', () => {
  it('falls back to UTC when nothing is configured', () => {
    expect(resolveTimeZone(undefined)).toBe(DEFAULT_TIME_ZONE);
    expect(resolveTimeZone('')).toBe(DEFAULT_TIME_ZONE);
    expect(resolveTimeZone('   ')).toBe(DEFAULT_TIME_ZONE);
  });

  it('accepts an IANA zone and trims it', () => {
    expect(resolveTimeZone('America/Sao_Paulo')).toBe('America/Sao_Paulo');
    expect(resolveTimeZone(' America/Sao_Paulo ')).toBe('America/Sao_Paulo');
  });

  /**
   * Thrown at construction, so a typo takes the boot down naming itself
   * rather than becoming a 500 on every report call afterwards.
   */
  it('refuses a zone Postgres would also refuse, naming the value', () => {
    expect(() => resolveTimeZone('America/Sao Paulo')).toThrow(
      /America\/Sao Paulo/,
    );
    expect(() => resolveTimeZone('BRT-3')).toThrow(/REPORTS_TIMEZONE/);
  });
});
