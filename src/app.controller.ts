import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AppService } from './app.service';
import { Public } from './auth/public.decorator';
import { HealthResponse } from './health.response';

@ApiTags('health')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Answers as long as the process is up and serving. It touches no database and no external provider on purpose: a liveness probe that fails when a dependency blinks gets the container restarted for no reason, turning one outage into two. Readiness — the check that does ask whether dependencies are reachable — is a separate route and does not exist yet.',
  })
  @ApiOkResponse({ type: HealthResponse })
  getHealth(): HealthResponse {
    return this.appService.getHealth();
  }
}
