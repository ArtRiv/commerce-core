import { ApiProperty } from '@nestjs/swagger';

/**
 * The body every failed request answers with — Nest's own exception shape,
 * described once here rather than re-declared on each of the ~120 error
 * responses in the document.
 *
 * `message` is a string for most failures and an ARRAY of strings when the
 * global ValidationPipe rejects a DTO (one entry per broken rule). That union
 * is not a wart worth hiding: a client rendering the message has to handle
 * both, and a schema claiming `string` would make generated clients wrong on
 * exactly the error they hit most.
 */
export class ErrorResponse {
  @ApiProperty({ example: 409, description: 'Mirrors the HTTP status code.' })
  statusCode: number;

  @ApiProperty({
    description:
      'A human-readable reason, or one entry per failed validation rule.',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    examples: [
      'Order is PAID; only a CREATED order can be paid',
      ['priceCents must be an integer number', 'name should not be empty'],
    ],
  })
  message: string | string[];

  @ApiProperty({
    example: 'Conflict',
    description: "The status code's canonical name.",
  })
  error: string;
}
