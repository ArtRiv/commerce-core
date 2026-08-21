/** One line of the order, exactly as it was frozen at checkout. */
export interface OrderEmailItem {
  productName: string;
  unitPriceCents: number;
  quantity: number;
}

/**
 * The freight an order was actually sold with.
 *
 * `methodName` is non-null here on purpose: an order that has no method has
 * no freight to describe, and says so by leaving the whole object null (see
 * OrderEmailData.freight). Zero cents with a method is free shipping, which
 * is a different thing and reads differently.
 */
export interface OrderEmailFreight {
  cents: number;
  methodName: string;
  etaDays: number | null;
}

export interface OrderEmailAddress {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
}

/**
 * Everything a lifecycle email says about an order.
 *
 * It belongs to `mail` rather than to `orders` so the arrow keeps pointing one
 * way: orders builds this and hands it over, and nothing here knows what a
 * Prisma Order looks like. See docs/specs/order-emails.md.
 */
export interface OrderEmailData {
  orderId: string;
  /** Null for an account that never gave a name — the greeting adapts. */
  customerName: string | null;
  items: readonly OrderEmailItem[];
  itemsSubtotalCents: number;
  /**
   * Null for an order created before the shipping module existed, where
   * shippingCents is a backfilled 0 and the method is unknown. Rendering that
   * as "Frete: R$ 0,00" would invent a fact, so the money block is omitted
   * entirely and only the total is shown.
   */
  freight: OrderEmailFreight | null;
  /** The amount charged: itemsSubtotalCents + freight (docs/specs/shipping.md). */
  totalCents: number;
  address: OrderEmailAddress;
}

/** Tracking is data hung on the shipment, and both halves are optional. */
export interface OrderShippedEmailData extends OrderEmailData {
  trackingCode: string | null;
  trackingUrl: string | null;
}

/**
 * Outbound transactional email.
 *
 * An interface behind a token rather than a concrete class so the provider is
 * swappable — tests bind a fake and never touch the network, and replacing
 * Resend later is a module change rather than an AuthService change.
 *
 * Methods are semantic, one per message, rather than a generic send(html):
 * the HTML stays on the provider's side of the boundary, and a test can assert
 * that an order was confirmed with its freight broken out instead of grepping
 * a string.
 *
 * Implementations must not throw for a delivery failure that the caller can
 * survive; see AuthService.register and docs/specs/auth.md — a mail outage must
 * not block sign-up. The order emails hold the same rule for a harder reason
 * (docs/specs/order-emails.md): half of them are sent from the Stripe webhook,
 * where any non-2xx is answered with days of redelivery.
 */
export interface MailService {
  sendVerificationEmail(to: string, token: string): Promise<void>;
  sendPasswordResetEmail(to: string, token: string): Promise<void>;

  sendOrderPaidEmail(to: string, data: OrderEmailData): Promise<void>;
  sendOrderShippedEmail(to: string, data: OrderShippedEmailData): Promise<void>;
  sendOrderRefundedEmail(to: string, data: OrderEmailData): Promise<void>;
  sendOrderCancelledEmail(to: string, data: OrderEmailData): Promise<void>;
}

export const MAIL_SERVICE = Symbol('MAIL_SERVICE');
