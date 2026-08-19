import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { PaymentsModule } from '../payments/payments.module';
import { ShippingModule } from '../shipping/shipping.module';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PaymentEventsService } from './payment-events.service';
import { PaymentWebhookController } from './payment-webhook.controller';
import { ShippingQuoteController } from './shipping-quote.controller';
import { ShippingQuoteService } from './shipping-quote.service';

/**
 * The orchestrator (docs/architecture/modules.md): imports CatalogModule for
 * the exported read/stock contract, PaymentsModule for the PaymentProvider
 * token and ShippingModule for the ShippingProvider one — the three
 * dependencies checkout needs, and the three arrows the module map draws out
 * of here. Nothing is exported; no other module consumes orders.
 *
 * PaymentWebhookController lives here rather than in `payments` because what a
 * payment event does is change an ORDER. Hosting it there would make payments
 * import orders, which is both a cycle and the reverse of this module map's one
 * rule. The provider hands over a domain PaymentEvent, so nothing Stripe-shaped
 * crosses into this module regardless.
 *
 * ShippingQuoteController is here for the same reason and serves
 * /shipping/quote: pricing freight means reading a cart, and a cart is ours.
 */
@Module({
  imports: [CatalogModule, PaymentsModule, ShippingModule],
  controllers: [
    CartController,
    OrdersController,
    PaymentWebhookController,
    ShippingQuoteController,
  ],
  providers: [
    CartService,
    OrdersService,
    PaymentEventsService,
    ShippingQuoteService,
  ],
})
export class OrdersModule {}
