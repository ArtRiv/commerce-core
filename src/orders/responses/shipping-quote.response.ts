import { ApiProperty } from '@nestjs/swagger';

export class ShippingOptionResponse {
  @ApiProperty({
    description:
      'Stable identity of the option. This is what POST /orders takes as `shippingOptionCode`.',
    example: 'padrao-sudeste',
  })
  code: string;

  @ApiProperty({ example: 'Entrega padrão' })
  label: string;

  @ApiProperty({
    description:
      'Integer cents. Zero is a real option at no cost, not a missing price.',
    example: 2490,
  })
  priceCents: number;

  @ApiProperty({ nullable: true, type: Number, example: 5 })
  estimatedDays: number | null;

  @ApiProperty({ nullable: true, type: String, example: 'Correios' })
  carrier: string | null;

  @ApiProperty({
    description:
      'THE AMOUNT THAT WILL BE CHARGED if the customer picks this option — `itemsSubtotalCents + priceCents`. It is what a checkout button renders ("Finalizar pedido — R$ 522,30") before any order exists, and it is the same number POST /orders produces as `totalCents`. On a free option it equals the subtotal exactly: zero is a real price, not a missing one.',
    example: 52230,
  })
  orderTotalCents: number;
}

/**
 * An object rather than a bare array so the shape can grow — an
 * `unavailableReason` alongside the list, say — without breaking every client.
 *
 * An EMPTY list is a legitimate 200: "we do not deliver there" is an answer
 * about the address, and no amount of retrying changes it. A provider that is
 * merely down answers 503 instead, and the two are kept distinguishable on
 * purpose.
 */
export class ShippingQuoteResponse {
  @ApiProperty({ type: [ShippingOptionResponse] })
  options: ShippingOptionResponse[];

  @ApiProperty({
    description:
      'The item subtotal of the cart this quote was measured against — the same number GET /cart reports, from the same definition. Present even when `options` is empty: what the cart is worth is a fact about the cart, not about whether anyone will carry it.',
    example: 49740,
  })
  itemsSubtotalCents: number;
}
