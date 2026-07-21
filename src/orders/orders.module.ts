import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { PaymentsModule } from '../payments/payments.module';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

/**
 * The orchestrator (docs/architecture/modules.md): imports CatalogModule for
 * the exported read/stock contract and PaymentsModule for the PaymentProvider
 * token — the only two dependencies checkout needs. Nothing is exported;
 * no other module consumes orders.
 */
@Module({
  imports: [CatalogModule, PaymentsModule],
  controllers: [CartController, OrdersController],
  providers: [CartService, OrdersService],
})
export class OrdersModule {}
