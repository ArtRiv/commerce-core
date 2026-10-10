export const COMMERCE_EVENTS_EXCHANGE = 'commerce.events';
export const COMMERCE_EVENTS_DLX = 'commerce.events.dlx';

export const ORDERS_PAID_QUEUE = 'orders.paid';
export const ORDERS_PAID_DLQ = 'orders.paid.dlq';

export const ORDER_PAID_ROUTING_KEY = 'order.paid';
export const ORDER_PAID_DLQ_ROUTING_KEY = 'orders.paid.dlq';

export const DEFAULT_RABBITMQ_URL = 'amqp://guest:guest@localhost:5672';
export const MAX_RETRY_COUNT = 3;
