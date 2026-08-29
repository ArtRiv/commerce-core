import { BadRequestException } from '@nestjs/common';

import { resolveWindow, toNaiveUtc } from './report-window';

const NOW = new Date('2026-08-29T12:00:00.000Z');

describe('resolveWindow', () => {
  it('defaults to the 30 days ending now', () => {
    const window = resolveWindow({}, NOW);

    expect(window.to).toEqual(NOW);
    expect(window.from).toEqual(new Date('2026-07-30T12:00:00.000Z'));
  });

  it('defaults only the end when a start was given', () => {
    const window = resolveWindow({ from: '2026-08-01T00:00:00.000Z' }, NOW);

    expect(window.from).toEqual(new Date('2026-08-01T00:00:00.000Z'));
    expect(window.to).toEqual(NOW);
  });

  it('measures the default 30 days back from the end that was given', () => {
    const window = resolveWindow({ to: '2026-03-31T00:00:00.000Z' }, NOW);

    expect(window.from).toEqual(new Date('2026-03-01T00:00:00.000Z'));
    expect(window.to).toEqual(new Date('2026-03-31T00:00:00.000Z'));
  });

  it('keeps both ends when both were given', () => {
    const window = resolveWindow(
      { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' },
      NOW,
    );

    expect(window.from).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(window.to).toEqual(new Date('2026-02-01T00:00:00.000Z'));
  });

  it('accepts a plain calendar date, read as midnight UTC', () => {
    const window = resolveWindow({ from: '2026-08-01', to: '2026-09-01' }, NOW);

    expect(window.from).toEqual(new Date('2026-08-01T00:00:00.000Z'));
    expect(window.to).toEqual(new Date('2026-09-01T00:00:00.000Z'));
  });

  // An impossible window is the caller's bug. Answering [] would hide it
  // behind something that reads as "nothing matched" — same stance as
  // minPriceCents > maxPriceCents on GET /products.
  it('refuses a start after the end', () => {
    expect(() =>
      resolveWindow(
        { from: '2026-09-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' },
        NOW,
      ),
    ).toThrow(BadRequestException);
  });

  // Half-open, so two adjacent months never count the same order twice.
  it('refuses an empty window, because `to` is exclusive', () => {
    expect(() =>
      resolveWindow(
        { from: '2026-08-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' },
        NOW,
      ),
    ).toThrow(BadRequestException);
  });

  it('refuses a date it cannot parse', () => {
    expect(() => resolveWindow({ from: 'last tuesday' }, NOW)).toThrow(
      BadRequestException,
    );
  });
});

describe('toNaiveUtc', () => {
  /**
   * The whole point: paid_at is TIMESTAMP(3) WITHOUT time zone holding a UTC
   * reading, so the bound value must carry no offset at all. A Date left to
   * the driver would be serialised with the process's offset, and the
   * ::timestamp cast would then discard that offset silently.
   */
  it('renders an instant as a UTC wall clock with no zone suffix', () => {
    expect(toNaiveUtc(new Date('2026-08-01T03:04:05.678Z'))).toBe(
      '2026-08-01T03:04:05.678',
    );
  });

  it('does not follow the machine into a local offset', () => {
    expect(toNaiveUtc(new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0)))).toBe(
      '2026-01-01T00:00:00.000',
    );
  });
});
