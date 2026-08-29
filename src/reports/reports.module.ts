import { Module } from '@nestjs/common';

import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * A leaf, and read-only (docs/specs/reports.md).
 *
 * It exports nothing: no other module may grow a dependency on a report, which
 * is what keeps this from becoming a back door into the domain. And it needs
 * no imports beyond the global PrismaModule, because it never calls another
 * module's service — it reads their tables directly.
 *
 * That last part is the one deliberate exception to the boundary rule in
 * docs/architecture/modules.md, and it is safe for exactly two reasons:
 * everything here is a SELECT of an aggregate, and nothing depends on it.
 * Routing these four queries through OrdersService and ProductsService would
 * have hung report-shaped methods — a `date_trunc` here, a `GROUP BY` there —
 * off two services with no other reason to know what a week bucket is; the
 * only other alternative was summing money in JavaScript, which the spec
 * forbids outright.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
