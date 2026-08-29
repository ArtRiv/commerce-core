import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import {
  REVENUE_GRANULARITIES,
  type RevenueGranularity,
} from '../reports.service';
import { ReportPeriodQueryDto } from './report-period-query.dto';

export class RevenueQueryDto extends ReportPeriodQueryDto {
  /**
   * No pagination here, unlike the other two period reports: a chart needs
   * the whole series, and the window already bounds it.
   */
  @ApiPropertyOptional({
    enum: REVENUE_GRANULARITIES,
    default: 'month',
    description:
      'Bucket size. Weeks start on **Monday** (ISO), and both are cut in the instance’s configured time zone — see the `timeZone` field on the response.',
  })
  @IsOptional()
  @IsIn(REVENUE_GRANULARITIES)
  granularity?: RevenueGranularity;
}
