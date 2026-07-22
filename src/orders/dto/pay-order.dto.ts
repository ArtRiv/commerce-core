import { IsIn, IsOptional } from 'class-validator';

import {
  CHECKOUT_MODES,
  type CheckoutMode,
} from '../../payments/payment-provider';

/**
 * Body of POST /orders/:id/pay. Everything about it is optional — asking for a
 * way to pay an order needs no input — but a client that renders its own
 * checkout can insist on the mode, which is what makes the reused session
 * either handed back or replaced.
 */
export class PayOrderDto {
  @IsOptional()
  @IsIn(CHECKOUT_MODES)
  paymentMode?: CheckoutMode;
}
