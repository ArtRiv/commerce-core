import { ApiProperty } from '@nestjs/swagger';

import { ReportPeriodResponse } from './report-period.response';

/** A piece that is for sale, has stock, and did not move in the window. */
export class UnsoldProductRowResponse {
  @ApiProperty({ format: 'uuid' })
  productId: string;

  @ApiProperty({ example: 'Calça Cargo' })
  name: string;

  @ApiProperty({ example: 'calca-cargo' })
  slug: string;

  @ApiProperty({
    description:
      'Summed across the piece’s sizes. Always greater than zero here — sold out is not "not moving", it is the opposite of it.',
    example: 12,
  })
  stockQuantity: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When this piece last sold, **of any era** — not restricted to the window, which by definition holds no sale of it. `null` means it has never sold at all, which is a different problem from having stopped selling.',
  })
  lastSoldAt: Date | null;
}

export class UnsoldProductsReportResponse extends ReportPeriodResponse {
  @ApiProperty({
    type: [UnsoldProductRowResponse],
    description:
      'Most stock first — the piece with the most capital standing still is the one a discount gets decided about. Ties break on product id.',
  })
  items: UnsoldProductRowResponse[];

  @ApiProperty({
    description: 'Matching pieces, not the page size.',
    example: 3,
  })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ description: 'Clamped to 100.', example: 20 })
  perPage: number;
}
