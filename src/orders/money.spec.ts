import { itemCount, itemsSubtotalCents } from './money';

describe('itemsSubtotalCents', () => {
  it('sums price × quantity', () => {
    expect(
      itemsSubtotalCents([
        { unitPriceCents: 1_000, quantity: 2 },
        { unitPriceCents: 2_500, quantity: 1 },
      ]),
    ).toBe(4_500);
  });

  it('is zero for nothing', () => {
    expect(itemsSubtotalCents([])).toBe(0);
  });
});

describe('itemCount', () => {
  it('sums quantities rather than counting lines', () => {
    // Two shirts and a pair of trousers is 3 pieces on the badge, not 2
    // lines. This is the whole reason the field exists.
    expect(itemCount([{ quantity: 2 }, { quantity: 1 }])).toBe(3);
  });

  it('is zero for an empty cart', () => {
    // Zero, not null and not absent: a badge that has to handle undefined is
    // a badly written contract (docs/specs/cart-totals.md).
    expect(itemCount([])).toBe(0);
  });
});
