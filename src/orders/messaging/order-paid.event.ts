export interface OrderPaidEvent {
  eventId: string;
  orderId: string;
  paymentIntentRef?: string;
  occurredAt: string;
  correlationId?: string;
}
