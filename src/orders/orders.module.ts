import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { MailModule } from '../mail/mail.module';
import { PaymentsModule } from '../payments/payments.module';
import { ShippingModule } from '../shipping/shipping.module';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { OrderNotificationsService } from './order-notifications.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PaymentEventsService } from './payment-events.service';
import { PaymentWebhookController } from './payment-webhook.controller';
import { ShippingQuoteController } from './shipping-quote.controller';
import { ShippingQuoteService } from './shipping-quote.service';

/**
 * The orchestrator (docs/architecture/modules.md): imports CatalogModule for
 * the exported read/stock contract, PaymentsModule for the PaymentProvider
 * token, ShippingModule for the ShippingProvider one, and MailModule for the
 * MailService one — the four arrows the module map draws out of here. Nothing
 * is exported; no other module consumes orders.
 *
 * MailModule is imported rather than inherited: it stopped being @Global when
 * this module became its second consumer, so the dependency is now in the
 * graph instead of in a comment. See docs/specs/order-emails.md.
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
  imports: [CatalogModule, PaymentsModule, ShippingModule, MailModule],
  controllers: [
    CartController,
    OrdersController,
    PaymentWebhookController,
    ShippingQuoteController,
  ],
  providers: [
    CartService,
    OrderNotificationsService,
    OrdersService,
    PaymentEventsService,
    ShippingQuoteService,
  ],
})
export class OrdersModule {}
