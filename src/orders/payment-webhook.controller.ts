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
import {
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { Public } from '../auth/public.decorator';
import { ClientIpThrottlerGuard } from '../common/throttling/client-ip-throttler.guard';
import {
  ApiBadRequest,
  ApiRateLimited,
  ApiServiceUnavailable,
} from '../openapi/api-errors.decorator';
import {
  PAYMENT_PROVIDER,
  type PaymentEvent,
  type PaymentProvider,
} from '../payments/payment-provider';
import { PaymentEventsService } from './payment-events.service';
import { RATE_LIMITS } from './rate-limits';
import { WebhookAckResponse } from './responses/webhook-ack.response';

/**
 * Documented as prose rather than a schema, because there is no schema to
 * document — see the class comment and docs/specs/openapi.md.
 */
const WEBHOOK_DESCRIPTION = [
  'Called by the payment provider, never by application code. **Do not generate a client for this route** — it exists to be configured as a webhook destination in the provider dashboard.',
  "**There is no request schema, and none is invented here.** The body is the provider's own event envelope, read as raw bytes and never parsed by this API before its signature is checked. It is not part of this API's contract: the provider changes it when it likes, and the only part that matters here — the signature — travels in a header. The global validation pipe never sees this body either, because no DTO describes it.",
  'Authentication is the `stripe-signature` header, an HMAC over exactly the bytes that were sent. That signature is the only thing standing between this route and anyone on the internet declaring an order paid, which is why the raw bytes are preserved instead of re-serialised from parsed JSON — re-serialising changes key order and spacing, and would invalidate every signature.',
  'A 200 means "recorded, stop redelivering", replays included: a redelivered event is acknowledged with `duplicate: true` rather than applied twice. Any non-2xx asks the provider to try again, which is this module\'s entire retry mechanism — the 503 below is deliberate for exactly that reason.',
].join('\n\n');

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
 * Tagged `payments` for the same reason the URL says payments: a consumer
 * reading the document is thinking about the payment provider, not about this
 * repository's module boundaries.
 *
 * Public by necessity — the caller is a machine with no account. The signature
 * is the authentication, and it is the only thing standing between this route
 * and anyone on the internet declaring an order paid.
 */
@ApiTags('payments')
@Controller('payments')
export class PaymentWebhookController {
  private readonly logger = new Logger(PaymentWebhookController.name);

  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
    private readonly events: PaymentEventsService,
  ) {}

  @Public()
  @UseGuards(ClientIpThrottlerGuard)
  @Throttle({ default: RATE_LIMITS.PAYMENT_WEBHOOK })
  @HttpCode(200)
  @Post('webhook')
  @ApiOperation({
    summary: 'Receive a payment provider event',
    description: WEBHOOK_DESCRIPTION,
  })
  @ApiHeader({
    name: 'stripe-signature',
    required: true,
    description:
      'HMAC over the raw request body. Verifying it is the authentication of this route.',
  })
  @ApiBody({
    required: true,
    description:
      "The provider's raw event payload, passed through unparsed. Opaque by design — see the operation description.",
    schema: { type: 'string', format: 'binary' },
  })
  @ApiOkResponse({ type: WebhookAckResponse })
  @ApiBadRequest(
    'The body is missing, or the signature does not verify. The two are deliberately indistinguishable and never detailed further.',
  )
  @ApiRateLimited(RATE_LIMITS.PAYMENT_WEBHOOK.limit, 'minute')
  @ApiServiceUnavailable(
    'Refused on purpose so the provider redelivers — a refund arriving before the payment that explains it, for instance. The event stays unprocessed rather than being marked done with the order left wrong.',
  )
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
