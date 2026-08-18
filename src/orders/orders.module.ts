import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { PaymentsModule } from '../payments/payments.module';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PaymentEventsService } from './payment-events.service';
import { PaymentWebhookController } from './payment-webhook.controller';

/**
 * The orchestrator (docs/architecture/modules.md): imports CatalogModule for
 * the exported read/stock contract and PaymentsModule for the PaymentProvider
 * token — the only two dependencies checkout needs. Nothing is exported;
 * no other module consumes orders.
 *
 * PaymentWebhookController lives here rather than in `payments` because what a
 * payment event does is change an ORDER. Hosting it there would make payments
 * import orders, which is both a cycle and the reverse of this module map's one
 * rule. The provider hands over a domain PaymentEvent, so nothing Stripe-shaped
 * crosses into this module regardless.
 */
@Module({
  imports: [CatalogModule, PaymentsModule],
  controllers: [CartController, OrdersController, PaymentWebhookController],
  providers: [CartService, OrdersService, PaymentEventsService],
})
export class OrdersModule {}
