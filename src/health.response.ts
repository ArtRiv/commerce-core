import { ApiProperty } from '@nestjs/swagger';

/**
 * Liveness only: it answers "this process is up and serving", which is what a
 * platform health check restarts a container over.
 *
 * It deliberately touches nothing — no database, no payment provider, no mail
 * provider. A liveness probe that queries Postgres restarts a perfectly
 * healthy API because a dependency blinked, which turns one outage into two.
 * The check that asks whether dependencies are reachable is readiness, and it
 * is a different route (docs/specs/openapi.md).
 */
export class HealthResponse {
  @ApiProperty({ example: 'ok', enum: ['ok'] })
  status: 'ok';

  @ApiProperty({
    description: 'Version of the published API contract.',
    example: '1.0.0',
  })
  version: string;

  @ApiProperty({
    description: 'Seconds since this process started.',
    example: 1042,
  })
  uptimeSeconds: number;
}
