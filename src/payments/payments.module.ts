import { Module } from '@nestjs/common';

import { FakePaymentProvider } from './fake-payment.provider';
import { PAYMENT_PROVIDER } from './payment-provider';

/**
 * Interface-only module for now (docs/specs/orders.md): the PaymentProvider
 * token with a fake bound to it. Not @Global on purpose — only orders may
 * charge money, and importing this module is how that dependency stays
 * visible in the module graph.
 */
@Module({
  providers: [{ provide: PAYMENT_PROVIDER, useClass: FakePaymentProvider }],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentsModule {}
