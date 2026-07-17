/**
 * Turns a display name into a URL slug: lowercase ASCII, hyphen-separated.
 * Diacritics are decomposed and dropped (Térmica → termica) rather than
 * mangled, since product names here are Portuguese more often than not.
 */
export function slugify(input: string, fallback = 'item'): string {
  const cleaned = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return cleaned || fallback;
}

/**
 * Picks `base`, or the first `base-n` (n ≥ 2) not in `taken`.
 *
 * `taken` is expected to come from a `startsWith(base)` query, so it may
 * contain unrelated slugs that merely share the prefix (camiseta-azul when
 * base is camiseta) — exact matches are what count. Only auto-generated
 * slugs go through this; an explicitly chosen slug that collides is a 409,
 * never silently suffixed (docs/specs/catalog.md).
 */
export function nextAvailableSlug(
  base: string,
  taken: readonly string[],
): string {
  const exact = new Set(taken);

  if (!exact.has(base)) {
    return base;
  }

  let n = 2;
  while (exact.has(`${base}-${String(n)}`)) {
    n += 1;
  }

  return `${base}-${String(n)}`;
}
