import { ApiProperty } from '@nestjs/swagger';

/**
 * The 409 body of a variant removal blocked by carts — either because nothing
 * was authorised, or because the impact changed since it was reviewed.
 *
 * Documented as its own schema rather than the shared `ErrorResponse` because
 * the number is the whole point: a panel cannot render "3 shopping carts
 * contain this size — remove anyway?" from a field its generated client does
 * not know exists. (The checkout 409 carries `unavailableItems` past an
 * `ErrorResponse` annotation today; that is a known gap in the orders spec,
 * not a pattern worth copying into a new route.)
 *
 * Note it has no `statusCode`/`error`: an HttpException constructed from an
 * object answers with exactly that object.
 */
export class VariantInCartsResponse {
  @ApiProperty({
    description: 'Human-readable, and names the count in both variations.',
    examples: [
      'This size is in 3 shopping carts',
      'Cart line count changed from 3 to 4; review and confirm again',
    ],
  })
  message: string;

  @ApiProperty({
    description:
      'How many cart lines hold this size **right now**. Send it back as `expectedCartLineCount` to confirm you reviewed this impact.',
    example: 3,
  })
  cartLineCount: number;
}
