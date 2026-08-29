import { ApiProperty } from '@nestjs/swagger';

import { REVENUE_GRANULARITIES } from '../reports.service';
import { ReportPeriodResponse } from './report-period.response';

export class RevenueBucketResponse {
  @ApiProperty({
    description:
      'First day of the bucket, as a **calendar date** in the instance’s time zone — `YYYY-MM-DD`, deliberately not an instant. An instant would invite the browser to re-read it in *its* zone and draw the bar in the previous week, which is the very error the server-side bucketing exists to avoid. Weeks start on Monday.',
    example: '2026-08-24',
  })
  periodStart: string;

  @ApiProperty({
    description:
      'Integer cents actually charged — `itemsSubtotalCents + shippingCents`, guaranteed, because the same sum is a CHECK constraint on every order.',
    example: 59920,
  })
  revenueCents: number;

  @ApiProperty({ description: 'The goods alone.', example: 55930 })
  itemsSubtotalCents: number;

  @ApiProperty({
    description: 'Freight, broken out — it is collected, not earned.',
    example: 3990,
  })
  shippingCents: number;

  @ApiProperty({ example: 4 })
  orderCount: number;
}

export class RevenueReportResponse extends ReportPeriodResponse {
  @ApiProperty({ enum: REVENUE_GRANULARITIES, example: 'month' })
  granularity: string;

  @ApiProperty({
    description:
      'The IANA zone the buckets were cut in (`REPORTS_TIMEZONE`, default `UTC`). It is here because a chart labelled with dates is unreadable without it: cutting a Brazilian store’s weeks in UTC pushes every Sunday evening into the following Monday.',
    example: 'America/Sao_Paulo',
  })
  timeZone: string;

  @ApiProperty({
    type: [RevenueBucketResponse],
    description:
      'Ascending, and **continuous**: a week or month with no sales comes back as zeros rather than as a gap, so a bar chart does not silently skip the bad week. Not paginated — a chart needs the whole series, and the window already bounds it.',
  })
  buckets: RevenueBucketResponse[];
}
