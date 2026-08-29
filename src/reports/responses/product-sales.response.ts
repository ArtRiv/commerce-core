import { ApiProperty } from '@nestjs/swagger';

import { ReportPeriodResponse } from './report-period.response';

/** One piece, and how much of it left in the period. */
export class ProductSalesRowResponse {
  @ApiProperty({ format: 'uuid' })
  productId: string;

  @ApiProperty({
    description:
      'The name the product carries **today**, from the catalogue — not the snapshot frozen onto the order. Rows are grouped by product id, so a piece renamed mid-period is still one line rather than two.',
    example: 'Camiseta Preta',
  })
  name: string;

  @ApiProperty({ example: 'camiseta-preta' })
  slug: string;

  @ApiProperty({
    description:
      'Pieces, summed across sizes. Two sizes of one shirt in one order are two order lines and one row here.',
    example: 7,
  })
  unitsSold: number;

  @ApiProperty({
    description:
      'Integer cents, from the **frozen** unit price of each line — what the customer actually paid, not today’s catalogue price. Items only: freight belongs to the order, not to a piece, and lives on `GET /reports/revenue`. Deliberately not called `revenueCents`, so the two are never added together.',
    example: 55930,
  })
  itemsRevenueCents: number;

  @ApiProperty({
    description: 'How many distinct orders included this piece.',
    example: 4,
  })
  orderCount: number;
}

export class ProductSalesReportResponse extends ReportPeriodResponse {
  @ApiProperty({
    type: [ProductSalesRowResponse],
    description: 'Best-selling first. Ties break on product id.',
  })
  items: ProductSalesRowResponse[];

  @ApiProperty({
    description: 'Distinct pieces sold in the window, not the page size.',
    example: 12,
  })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ description: 'Clamped to 100.', example: 20 })
  perPage: number;
}
