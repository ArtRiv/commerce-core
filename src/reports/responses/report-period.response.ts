import { ApiProperty } from '@nestjs/swagger';

/**
 * The window a report actually used, echoed back.
 *
 * Present on every period report because both ends are optional on the way
 * in: a panel that sent neither would otherwise have to guess what "the last
 * 30 days" resolved to before it could label the chart.
 */
export class ReportPeriodResponse {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Start of the window, inclusive.',
  })
  from: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'End of the window, **exclusive**.',
  })
  to: Date;
}
