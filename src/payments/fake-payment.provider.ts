import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { PaymentProvider } from './payment-provider';

/**
 * The v1 stand-in for a real gateway: acknowledges every payment with a
 * unique reference and never fails. Infallibility is a feature here — it
 * keeps "provider errored after the checkout transaction committed" out of
 * v1's state space; handling that for real (retry, reconciliation) arrives
 * with Stripe. See docs/specs/orders.md, edge cases.
 */
@Injectable()
export class FakePaymentProvider implements PaymentProvider {
  createPayment(): Promise<{ providerRef: string }> {
    return Promise.resolve({ providerRef: `fake_${randomUUID()}` });
  }
}
