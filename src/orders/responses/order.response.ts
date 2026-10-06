import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { OrderStatus } from '../../generated/prisma/enums';
import {
  CHECKOUT_MODES,
  type CheckoutMode,
  PAYMENT_METHODS,
  type PaymentMethod,
} from '../../payments/payment-provider';

/**
 * A line of the financial record. `productName`, `variantLabel` and
 * `unitPriceCents` are frozen at checkout: a later price change or a size
 * renamed in the catalog never reaches an order that already exists, and no
 * endpoint edits these.
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
    format: 'uuid',
    description: 'The size that was bought. Traceability, like productId.',
  })
  variantId: string;

  @ApiProperty({
    description:
      "The size's label at the moment of purchase — a snapshot, exactly like the name and the price. Renaming a size later never rewrites an order that already exists.",
    example: 'M',
  })
  variantLabel: string;

  @ApiProperty({
    description: 'The price at the moment of purchase, in cents.',
    example: 7990,
  })
  unitPriceCents: number;

  @ApiProperty({ example: 2 })
  quantity: number;
}

/**
 * PIX payment credentials returned in the payment session.
 * Both payload (Copia e Cola) and encodedImage (base64 QR PNG) are included
 * so the order page can render the QR Code without a second round-trip.
 */
export class PixSessionResponse {
  @ApiProperty({
    description:
      'The EMV-standard Copia e Cola text string the buyer pastes into their bank app.',
    example: '00020126360014BR.GOV.BCB.PIX...',
  })
  payload: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Base64-encoded PNG of the dynamic QR Code, ready for <img src="...">. Null when the provider did not return one yet.',
  })
  encodedImage: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  expirationDate: Date;
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

  @ApiPropertyOptional({
    type: PixSessionResponse,
    nullable: true,
    description:
      'PIX credentials — only present when the payment method is PIX. Contains the QR Code image and the Copia e Cola EMV payload.',
  })
  pix?: PixSessionResponse | null;
}

/**
 * Who bought, for a back office that has to show a person rather than a UUID.
 *
 * Three fields, declared one at a time. `User` also carries `passwordHash`
 * and `googleId`, and this class existing — instead of the user object being
 * passed through — is what keeps them out of a response (docs/admin-api.md,
 * item 2, and docs/specs/order-buyer.md).
 */
export class OrderBuyerResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Null on an account created through Google, which never passed through registration and so never set one. Display has to survive it.',
    example: 'Marina Duarte',
  })
  name: string | null;

  @ApiProperty({ format: 'email', example: 'marina@example.com' })
  email: string;
}

export class OrderResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid', description: 'The buyer.' })
  userId: string;

  @ApiProperty({
    type: OrderBuyerResponse,
    nullable: true,
    description:
      'Who placed the order — **only for a caller holding `orders.read`**, and null for everyone else, the buyer included. Null rather than absent: the field is always in the contract and only its value varies.\n\nIt names the buyer of *this order*; it is not a customer directory. Listing customers is a different surface and does not exist yet.',
  })
  buyer: OrderBuyerResponse | null;

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

  @ApiProperty({ nullable: true, type: String, example: 'Rua das Flores' })
  shippingStreet: string | null;

  @ApiProperty({ nullable: true, type: String, example: '100' })
  shippingNumber: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'Apto 42' })
  shippingComplement: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'Centro' })
  shippingNeighborhood: string | null;

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

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Reference ID of the order in Bling ERP for NF-e emission.',
    example: '12345678',
  })
  blingOrderId: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'When the order was successfully exported to Bling ERP.',
  })
  blingExportedAt: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Temporary download URL for the carrier shipping label PDF.',
    example: 'https://melhorenvio.com.br/labels/shipment-123.pdf',
  })
  labelUrl: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'When the shipping label was purchased from the carrier.',
  })
  labelPurchasedAt: Date | null;

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

  @ApiPropertyOptional({
    enum: PAYMENT_METHODS,
    nullable: true,
    type: String,
    description:
      'Which gateway processed this order. PIX=Asaas, CREDIT_CARD=MercadoPago, STRIPE=Stripe. Null for legacy orders.',
    example: 'PIX',
  })
  paymentMethod: PaymentMethod | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'The EMV-standard Copia e Cola string for PIX payments. Present on PIX orders — the order page renders this so the buyer can copy-paste into their bank app.',
    example: '00020126360014BR.GOV.BCB.PIX...',
  })
  pixPayload: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'Base64-encoded PNG of the dynamic PIX QR Code. Present on PIX orders when the provider returned an image. Render with <img src="data:image/png;base64,..." />.',
  })
  pixQrCode: string | null;

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

export class OrderStatusCountsResponse {
  @ApiProperty({ example: 10 })
  all: number;

  @ApiProperty({ example: 4 })
  CREATED: number;

  @ApiProperty({ example: 3 })
  PAID: number;

  @ApiProperty({ example: 2 })
  SHIPPED: number;

  @ApiProperty({ example: 1 })
  DELIVERED: number;

  @ApiProperty({ example: 0 })
  CANCELLED: number;

  @ApiProperty({ example: 0 })
  REFUNDED: number;
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

  @ApiProperty({
    type: OrderStatusCountsResponse,
    description: 'Counts broken down by status for the current scope.',
  })
  statusCounts: OrderStatusCountsResponse;
}
