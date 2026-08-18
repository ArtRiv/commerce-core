import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  Logger,
  Post,
  type RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

import { Public } from '../auth/public.decorator';
import {
  PAYMENT_PROVIDER,
  type PaymentEvent,
  type PaymentProvider,
} from '../payments/payment-provider';
import { PaymentEventsService } from './payment-events.service';
import { RATE_LIMITS } from './rate-limits';

/**
 * Where the payment provider tells us what happened.
 *
 * This controller lives in `orders`, not in `payments`, even though its URL
 * says otherwise: reacting to a payment is a change to an ORDER, and putting
 * it in `payments` would make payments depend on orders — a cycle, and the
 * reverse of the rule in docs/architecture/modules.md. What keeps that honest
 * is that nothing here is Stripe-shaped: the provider verifies and translates,
 * and this route only ever sees a domain PaymentEvent.
 *
 * Public by necessity — the caller is a machine with no account. The signature
 * is the authentication, and it is the only thing standing between this route
 * and anyone on the internet declaring an order paid.
 */
@Controller('payments')
export class PaymentWebhookController {
  private readonly logger = new Logger(PaymentWebhookController.name);

  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
    private readonly events: PaymentEventsService,
  ) {}

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: RATE_LIMITS.PAYMENT_WEBHOOK })
  @HttpCode(200)
  @Post('webhook')
  async handle(@Req() request: RawBodyRequest<Request>) {
    // The exact bytes, not the parsed body: the signature is an HMAC over what
    // was sent, and JSON.stringify(request.body) does not reproduce it (key
    // order, spacing, unicode escapes). This is why the app is created with
    // rawBody: true. No DTO either — the payload belongs to the provider, and
    // the global ValidationPipe only validates where a class says what to
    // expect.
    const rawBody = request.rawBody;

    if (!rawBody) {
      throw new BadRequestException('Missing request body');
    }

    let event: PaymentEvent;

    try {
      event = this.payments.parseEvent(rawBody, request.headers);
    } catch (error: unknown) {
      this.logger.warn(
        `Rejected a payment webhook: ${error instanceof Error ? error.message : String(error)}`,
      );

      throw new BadRequestException('Invalid payment webhook signature');
    }

    // Anything thrown from here on is a real failure and deliberately reaches
    // the provider as a 5xx: its redelivery is this module's retry mechanism,
    // so swallowing an error would throw the retry away with it.
    const outcome = await this.events.handle(event);

    return { received: true, duplicate: outcome === 'duplicate' };
  }
}
