import { Injectable } from '@nestjs/common';

import type { HealthResponse } from './health.response';
import { API_VERSION } from './openapi/document';

@Injectable()
export class AppService {
  /**
   * Liveness. Reads nothing and reaches nothing — see HealthResponse for why
   * a probe that queries the database is the wrong shape.
   *
   * `process.uptime()` is seconds with a fractional part; it is rounded
   * because nobody reads microseconds off a health check, and a stable
   * integer diffs better in logs.
   */
  getHealth(): HealthResponse {
    return {
      status: 'ok',
      version: API_VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
