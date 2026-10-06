/**
 * Port (interface) for ERP/fiscal integration, following the same hexagonal
 * seam as PaymentProvider and ShippingProvider. The orders module depends on
 * this token, never on a concrete ERP implementation.
 *
 * Today the only concrete implementation is BlingErpService. NoOpErpService
 * is used when BLING_API_KEY is not set (development without credentials).
 */

export interface CanonicalOrderItem {
  variantId: string;
  productName: string;
  variantLabel: string;
  unitPriceCents: number;
  quantity: number;
}

export interface CanonicalAddress {
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string;
  state: string;
  postalCode: string;
}

export interface CanonicalBuyer {
  name: string | null;
  email: string;
}

/**
 * Canonical order representation passed to exportOrder.
 *
 * Contains only the data the ERP integration needs — it is not the full
 * Prisma Order model. The mapping from Prisma row to this shape happens in
 * OrdersService, keeping the erp module free of Prisma imports.
 */
export interface CanonicalOrder {
  id: string;
  totalCents: number;
  itemsSubtotalCents: number;
  shippingCents: number;
  shippingMethodName: string | null;
  items: CanonicalOrderItem[];
  address: CanonicalAddress;
  buyer: CanonicalBuyer;
  paidAt: Date | null;
}

export interface ErpExportResult {
  /** The ERP's own id for the order. Stored in Order.blingOrderId. */
  erpOrderId: string;
}

export interface ErpService {
  /**
   * Creates a corresponding order record in the ERP system.
   *
   * Called after a successful CREATED → PAID transition. A failure here
   * MUST NOT roll back the payment transition — it is logged and the order
   * remains PAID with blingOrderId = null for manual reprocessing.
   */
  exportOrder(order: CanonicalOrder): Promise<ErpExportResult>;
}

export const ERP_SERVICE = Symbol('ERP_SERVICE');
