import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PERMISSIONS } from '../auth/authz/permissions';
import { RequirePermissions } from '../auth/authz/require-permissions.decorator';
import { ApiBadRequest } from '../openapi/api-errors.decorator';
import { PaginatedPeriodQueryDto } from './dto/report-period-query.dto';
import { RevenueQueryDto } from './dto/revenue-query.dto';
import { ReportsService } from './reports.service';
import { CartsReportResponse } from './responses/carts.response';
import { ProductSalesReportResponse } from './responses/product-sales.response';
import { RevenueReportResponse } from './responses/revenue.response';
import { UnsoldProductsReportResponse } from './responses/unsold-products.response';

/** Every route names the same window, so the description is written once. */
const WINDOW =
  'The window is `[from, to)` — start inclusive, end **exclusive**, so asking for two adjacent months never counts an order twice. Both are optional: omit `to` for now, omit `from` for 30 days before `to`.';

/** And so is the one definition of a sale, which is the point of this module. */
const SALE =
  'A sale is an order that is `PAID`, `SHIPPED` or `DELIVERED`, timed by **`paidAt`** — when the money arrived, not when the cart froze.\n\n`CREATED` does not count: the stock left the shelf but nothing was paid, and half of those orders never are. `CANCELLED` and `REFUNDED` do not count either, and both return their units to stock — so "units sold" and "stock that left the shelf" keep saying the same thing.';

/**
 * The four questions a back office asks, and nothing else
 * (docs/specs/reports.md). All four are gated on `reports.read`, which
 * `operator` and `admin` hold and which had no route behind it until now.
 *
 * They answer **403** rather than 404, and that does not contradict the
 * house pattern: 404-instead-of-403 protects the existence of a *resource* —
 * a DRAFT product, someone else's order — from being confirmed to whoever
 * probes an id. No route here takes an id of any kind, so there is no
 * existence to leak; all a 403 reveals is that /reports exists, which the
 * published OpenAPI document already says.
 *
 * Read-only, all four. Nothing in this module writes.
 */
@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @RequirePermissions(PERMISSIONS.REPORTS_READ)
  @Get('product-sales')
  @ApiOperation({
    summary: 'Units and revenue per piece, over a period',
    description: `How much of each piece left, best-selling first.\n\n${SALE}\n\n${WINDOW}\n\nRows are grouped by **product id** and named from the live catalogue, so renaming a piece mid-period does not split it into two lines. Sizes are summed together: which size to restock is a different question, and this route does not answer it.\n\n\`itemsRevenueCents\` is the goods alone, at the price frozen on each order line. Freight is not attributable to a piece and lives on \`GET /reports/revenue\`.`,
  })
  @ApiOkResponse({ type: ProductSalesReportResponse })
  @ApiBadRequest(
    '`from` is at or after `to`, or one of them is not an ISO-8601 date.',
  )
  productSales(@Query() query: PaginatedPeriodQueryDto) {
    return this.reports.productSales(query);
  }

  @RequirePermissions(PERMISSIONS.REPORTS_READ)
  @Get('revenue')
  @ApiOperation({
    summary: 'Revenue by week or by month',
    description: `A continuous series: a bucket with no sales comes back as zeros rather than as a gap, so a bar chart cannot silently skip the bad week. Not paginated — the window already bounds it.\n\n${SALE}\n\n${WINDOW}\n\nBuckets are cut in the instance's configured time zone (\`REPORTS_TIMEZONE\`, default \`UTC\`), reported back as \`timeZone\`: cutting a Brazilian store's weeks in UTC would push every Sunday evening into the following Monday. \`periodStart\` is therefore a calendar date, not an instant.\n\n\`revenueCents\` is what was charged; \`itemsSubtotalCents\` and \`shippingCents\` are the two halves of it, broken out because freight is collected rather than earned.`,
  })
  @ApiOkResponse({ type: RevenueReportResponse })
  @ApiBadRequest(
    '`from` is at or after `to`, one of them is not an ISO-8601 date, or `granularity` is outside the enum.',
  )
  revenue(@Query() query: RevenueQueryDto) {
    return this.reports.revenue(query);
  }

  @RequirePermissions(PERMISSIONS.REPORTS_READ)
  @Get('carts')
  @ApiOperation({
    summary: 'What is sitting in shopping carts right now',
    description:
      'A snapshot, with no period — carts have no history, only a present.\n\n`unitCount` counts **pieces**, not lines: three of one size in one bag is 3. `cartCount` counts carts that hold at least one line, because checkout consumes the items and leaves the cart row alive and empty — counting carts would count everyone who ever bought once.\n\nThis number previously existed only inside the 409 from removing a variant, and not even in this shape: that one counts cart *lines* holding a single size.',
  })
  @ApiOkResponse({ type: CartsReportResponse })
  carts() {
    return this.reports.carts();
  }

  @RequirePermissions(PERMISSIONS.REPORTS_READ)
  @Get('unsold-products')
  @ApiOperation({
    summary: 'Pieces that are not moving',
    description: `ACTIVE, holding stock, and with no sale in the window — the three conditions together. A sold-out piece is **not** listed: that is the opposite of not moving. Neither is a DRAFT or ARCHIVED one, which is not for sale to begin with.\n\n${SALE} The same definition decides "no sale", so this list is the exact complement of \`GET /reports/product-sales\`.\n\n${WINDOW}\n\n\`lastSoldAt\` reaches outside the window on purpose — it is the last sale of any era, or \`null\` for a piece that has never sold, which is a different problem from one that stopped.\n\nOrdered by stock descending: the piece with the most capital standing still comes first.`,
  })
  @ApiOkResponse({ type: UnsoldProductsReportResponse })
  @ApiBadRequest(
    '`from` is at or after `to`, or one of them is not an ISO-8601 date.',
  )
  unsoldProducts(@Query() query: PaginatedPeriodQueryDto) {
    return this.reports.unsoldProducts(query);
  }
}
