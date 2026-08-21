import { ApiProperty } from '@nestjs/swagger';

import { OrderStatus } from '../../generated/prisma/enums';
import {
  CHECKOUT_MODES,
  type CheckoutMode,
} from '../../payments/payment-provider';

/**
 * A line of the financial record. `productName` and `unitPriceCents` are
 * frozen at checkout: a later price change in the catalog never reaches an
 * order that already exists, and no endpoint edits these.
 */
export class OrderItemResponse {
  @ApiProperty({
    format: 'uuid',
    description:
      'Traceability back to the catalog. What to display is the snapshot beside it.',
  })
  productId: string;

  @ApiProperty({
    description: 'The name at the moment of purchase.',
    example: 'Camiseta Azul',
  })
  productName: string;

  @ApiProperty({
    description: 'The price at the moment of purchase, in cents.',
    example: 7990,
  })
  unitPriceCents: number;

  @ApiProperty({ example: 2 })
  quantity: number;
}

/**
 * How to actually pay an order. Transient — assembled per request, never a
 * database row, which is what lets `clientSecret` exist without ever being
 * stored.
 */
export class PaymentSessionResponse {
  @ApiProperty({
    enum: CHECKOUT_MODES,
    description:
      '`hosted` redirects the buyer to the provider; `embedded` renders checkout inside your own page.',
  })
  mode: CheckoutMode;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Where to send the buyer. Always null in `embedded` mode.',
    example: 'https://checkout.stripe.com/c/pay/cs_test_…',
  })
  url: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'CREDENTIAL — hand it to the provider SDK in the browser and nowhere else. Always null in `hosted` mode, and never persisted by this API.',
    example: 'cs_test_…_secret_…',
  })
  clientSecret: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
}

export class OrderResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid', description: 'The buyer.' })
  userId: string;

  @ApiProperty({
    enum: OrderStatus,
    description:
      'CREATED → PAID → SHIPPED → DELIVERED, with CREATED → CANCELLED and PAID → REFUNDED as the two exits. Any transition outside that map answers 409.',
  })
  status: OrderStatus;

  @ApiProperty({
    description: 'Sum of unitPriceCents × quantity over the items.',
    example: 15980,
  })
  itemsSubtotalCents: number;

  @ApiProperty({
    description:
      'Freight, frozen at checkout. Zero is legitimate (free shipping).',
    example: 2490,
  })
  shippingCents: number;

  @ApiProperty({
    description:
      'THE AMOUNT CHARGED — itemsSubtotalCents + shippingCents, guaranteed by a database constraint.',
    example: 18470,
  })
  totalCents: number;

  @ApiProperty({ type: [OrderItemResponse] })
  items: OrderItemResponse[];

  @ApiProperty({ example: 'Rua das Flores, 100' })
  shippingLine1: string;

  @ApiProperty({ nullable: true, type: String, example: 'Apto 42' })
  shippingLine2: string | null;

  @ApiProperty({ example: 'Curitiba' })
  shippingCity: string;

  @ApiProperty({ example: 'PR' })
  shippingState: string;

  @ApiProperty({ example: '80000-000' })
  shippingPostalCode: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'The freight option chosen at checkout. Null only on orders predating freight.',
    example: 'padrao-sudeste',
  })
  shippingMethodCode: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'Entrega padrão' })
  shippingMethodName: string | null;

  @ApiProperty({ nullable: true, type: Number, example: 5 })
  shippingEtaDays: number | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Optional — a local hand-off is a real shipment with no code.',
    example: 'BR123456789BR',
  })
  trackingCode: string | null;

  @ApiProperty({ nullable: true, type: String })
  trackingUrl: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      "INTERNAL — the payment provider's checkout session id. No client should depend on it; see docs/known-issues.md.",
    example: 'cs_test_…',
  })
  paymentRef: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Hosted checkout URL of the last session issued. Prefer the `payment` object.',
  })
  paymentUrl: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  paymentExpiresAt: Date | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      "INTERNAL — the provider's payment intent id. See docs/known-issues.md.",
    example: 'pi_test_…',
  })
  paymentIntentRef: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      "INTERNAL — the provider's refund id. See docs/known-issues.md.",
    example: 're_test_…',
  })
  refundRef: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  refundedAt: Date | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  paidAt: Date | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  shippedAt: Date | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  deliveredAt: Date | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  cancelledAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

/**
 * What checkout and /pay answer with: the order, plus the way to pay it.
 *
 * `payment` is null when the provider could not be reached. That is a
 * recoverable state, not a failed checkout — the order is real, and
 * POST /orders/{id}/pay issues the session later.
 */
export class OrderWithPaymentResponse extends OrderResponse {
  @ApiProperty({
    type: PaymentSessionResponse,
    nullable: true,
    description: 'Null when the payment provider was unreachable.',
  })
  payment: PaymentSessionResponse | null;
}

export class PaginatedOrdersResponse {
  @ApiProperty({ type: [OrderResponse] })
  items: OrderResponse[];

  @ApiProperty({ example: 12 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ description: 'Clamped to 100.', example: 20 })
  perPage: number;
}
