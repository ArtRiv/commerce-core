import { ApiProperty } from '@nestjs/swagger';

/**
 * What is sitting in shopping carts right now. No period — carts have no
 * history, only a present.
 */
export class CartsReportResponse {
  @ApiProperty({
    description:
      'Pieces, not lines: three of one size in one bag counts 3. This is the number `VariantInCartsResponse.cartLineCount` is **not** — that one counts the cart *lines* holding a single variant, which is a different question about a different scope.',
    example: 40,
  })
  unitCount: number;

  @ApiProperty({
    description: 'Cart lines — one per size held, whatever its quantity.',
    example: 12,
  })
  lineCount: number;

  @ApiProperty({
    description:
      'Carts holding at least one line. Checkout consumes the items and leaves the cart row alive and empty, so this counts baskets in play rather than everyone who ever bought once.\n\nIt is here because the unit count alone does not read: 40 units across 2 carts and 40 across 30 are opposite situations.',
    example: 2,
  })
  cartCount: number;
}
