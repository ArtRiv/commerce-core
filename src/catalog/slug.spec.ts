import { nextAvailableSlug, slugify } from './slug';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Camiseta Azul')).toBe('camiseta-azul');
  });

  it('strips diacritics', () => {
    expect(slugify('Térmica São João')).toBe('termica-sao-joao');
  });

  it('collapses punctuation runs into one hyphen', () => {
    expect(slugify('Kit -- 2 (novo!)')).toBe('kit-2-novo');
  });

  it('trims leading and trailing separators', () => {
    expect(slugify('  ¡Oferta!  ')).toBe('oferta');
  });

  it('falls back when nothing survives the cleanup', () => {
    // A name like "!!!" is legal input; an empty slug is not a legal slug —
    // it would collide with the next empty one and make an unusable URL.
    expect(slugify('!!!', 'produto')).toBe('produto');
  });
});

describe('nextAvailableSlug', () => {
  it('returns the base when it is free', () => {
    expect(nextAvailableSlug('camiseta', [])).toBe('camiseta');
  });

  it('suffixes from -2 when the base is taken', () => {
    expect(nextAvailableSlug('camiseta', ['camiseta'])).toBe('camiseta-2');
  });

  it('skips suffixes already taken', () => {
    expect(
      nextAvailableSlug('camiseta', ['camiseta', 'camiseta-2', 'camiseta-3']),
    ).toBe('camiseta-4');
  });

  it('ignores unrelated slugs that merely share the prefix', () => {
    // The taken list comes from a startsWith query, so "camiseta-azul" shows
    // up when the base is "camiseta" — it must not push the base aside.
    expect(nextAvailableSlug('camiseta', ['camiseta-azul'])).toBe('camiseta');
  });
});
