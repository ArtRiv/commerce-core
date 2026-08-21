import { ApiProperty } from '@nestjs/swagger';

/**
 * The acknowledgement the payment provider reads.
 *
 * A 200 means "recorded, stop redelivering". Anything else — including the
 * deliberate 503 when a refund arrives before the payment that explains it —
 * asks the provider to try again, which is this module's entire retry
 * mechanism.
 */
export class WebhookAckResponse {
  @ApiProperty({
    example: true,
    description: 'Always true; a failure is a non-2xx.',
  })
  received: boolean;

  @ApiProperty({
    example: false,
    description:
      'True when this event id had already been processed. Redelivery is normal and is not an error — the event is simply not applied twice.',
  })
  duplicate: boolean;
}
