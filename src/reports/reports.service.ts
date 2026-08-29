import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Prisma } from '../generated/prisma/client';
import { OrderStatus, ProductStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { toCount, toInstant } from './aggregates';
import { resolveTimeZone } from './report-timezone';
import {
  type ReportWindow,
  type ReportWindowInput,
  resolveWindow,
  toNaiveUtc,
} from './report-window';

/**
 * What counts as a sale — the one definition, used by all four reports.
 *
 * CREATED is out: the stock left the shelf but the money did not arrive, and
 * half of those orders never get paid. CANCELLED and REFUNDED are out too, and
 * both RESTOCK on their way out, so leaving them out is also what keeps "units
 * sold" and "stock that left the shelf" saying the same thing.
 *
 * `unsoldProducts` uses this list as well, deliberately: "no sales in the
 * period" has to be the exact complement of "sold in the period", or two
 * screens of the same panel contradict each other.
 *
 * See docs/specs/reports.md, invariant 1.
 */
const SOLD_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

export const REVENUE_GRANULARITIES = ['week', 'month'] as const;
export type RevenueGranularity = (typeof REVENUE_GRANULARITIES)[number];

const MAX_PER_PAGE = 100;

export interface PaginatedReportInput extends ReportWindowInput {
  page?: number;
  perPage?: number;
}

export interface RevenueReportInput extends ReportWindowInput {
  granularity?: RevenueGranularity;
}

export interface ProductSalesRow {
  productId: string;
  name: string;
  slug: string;
  unitsSold: number;
  itemsRevenueCents: number;
  orderCount: number;
}

export interface RevenueBucket {
  periodStart: string;
  revenueCents: number;
  itemsSubtotalCents: number;
  shippingCents: number;
  orderCount: number;
}

export interface UnsoldProductRow {
  productId: string;
  name: string;
  slug: string;
  stockQuantity: number;
  lastSoldAt: Date | null;
}

interface Page {
  page: number;
  perPage: number;
  skip: number;
}

/** Values above 100 are clamped rather than rejected, as everywhere else. */
function paginate(input: PaginatedReportInput): Page {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const perPage = Math.min(
    MAX_PER_PAGE,
    Math.max(1, Math.trunc(input.perPage ?? 20)),
  );

  return { page, perPage, skip: (page - 1) * perPage };
}

/**
 * The four questions a back office asks, answered by aggregating in Postgres.
 *
 * Read-only, always: nothing here inserts, updates or deletes, and the module
 * exports nothing, so no other module can grow a dependency on it.
 *
 * Every query is raw and every one is a `Prisma.sql` VALUE rather than a
 * tagged template on `$queryRaw`. That is not style — it is what lets the
 * shared fragments below exist, so the definition of a sale and the window are
 * written once and composed into four queries instead of copied into them.
 * Every interpolation is a bound parameter; nothing is concatenated.
 *
 * This module reads tables it does not own (orders, order_items, products,
 * product_variants, cart_items), which is the one place in the repo that
 * crosses a module's boundary at the database instead of through its service.
 * The alternative was report-shaped methods hanging off OrdersService and
 * ProductsService, or summing money in JavaScript. See docs/specs/reports.md,
 * invariant 11.
 */
@Injectable()
export class ReportsService {
  /** Where weeks and months are cut. Validated at construction. */
  private readonly timeZone: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.timeZone = resolveTimeZone(config.get<string>('REPORTS_TIMEZONE'));
  }

  async productSales(input: PaginatedReportInput) {
    const window = resolveWindow(input);
    const { page, perPage, skip } = paginate(input);
    const sold = this.soldInWindow(window);

    const [rows, totals] = await this.prisma.$transaction([
      this.prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT oi."product_id" AS "productId",
               p."name" AS "name",
               p."slug" AS "slug",
               SUM(oi."quantity")::bigint AS "unitsSold",
               SUM(oi."unit_price_cents" * oi."quantity")::bigint AS "itemsRevenueCents",
               COUNT(DISTINCT oi."order_id")::bigint AS "orderCount"
        FROM "order_items" oi
        JOIN "orders" o ON o."id" = oi."order_id"
        -- Safe by construction: OrderItem.product is onDelete Restrict and the
        -- catalogue archives instead of deleting, so the row is always there.
        JOIN "products" p ON p."id" = oi."product_id"
        WHERE ${sold}
        -- By id, not by the order's productName snapshot: grouping by the
        -- snapshot splits a piece in two the day it is renamed mid-period.
        GROUP BY oi."product_id", p."name", p."slug"
        ORDER BY "unitsSold" DESC, oi."product_id" ASC
        LIMIT ${perPage} OFFSET ${skip}
      `),
      this.prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT COUNT(DISTINCT oi."product_id")::bigint AS "total"
        FROM "order_items" oi
        JOIN "orders" o ON o."id" = oi."order_id"
        WHERE ${sold}
      `),
    ]);

    const items: ProductSalesRow[] = rows.map((row) => ({
      productId: String(row.productId),
      name: String(row.name),
      slug: String(row.slug),
      unitsSold: toCount(row.unitsSold),
      itemsRevenueCents: toCount(row.itemsRevenueCents),
      orderCount: toCount(row.orderCount),
    }));

    return {
      from: window.from,
      to: window.to,
      items,
      total: toCount(totals[0]?.total),
      page,
      perPage,
    };
  }

  async revenue(input: RevenueReportInput) {
    const window = resolveWindow(input);
    const granularity: RevenueGranularity = input.granularity ?? 'month';
    const zone = this.timeZone;

    const from = toNaiveUtc(window.from);
    const to = toNaiveUtc(window.to);

    const rows = await this.prisma.$queryRaw<Record<string, unknown>[]>(
      Prisma.sql`
        WITH "sales" AS (
          SELECT ${this.bucketOf(Prisma.sql`o."paid_at"`, granularity)} AS "bucket",
                 SUM(o."total_cents")::bigint AS "revenueCents",
                 SUM(o."items_subtotal_cents")::bigint AS "itemsSubtotalCents",
                 SUM(o."shipping_cents")::bigint AS "shippingCents",
                 COUNT(*)::bigint AS "orderCount"
          FROM "orders" o
          WHERE ${this.soldInWindow(window)}
          GROUP BY 1
        ),
        -- The calendar, so a week with no sales is a bucket of zeros rather
        -- than a gap a bar chart would draw as a store that was closed. The
        -- end is stepped back one microsecond because the window is half-open:
        -- an end landing exactly on a boundary must not open a trailing bucket.
        "series" AS (
          SELECT generate_series(
            ${this.bucketOf(Prisma.sql`${from}::timestamp`, granularity)},
            ${this.bucketOf(
              Prisma.sql`(${to}::timestamp - interval '1 microsecond')`,
              granularity,
            )},
            ('1 ' || ${granularity})::interval
          ) AS "bucket"
        )
        SELECT to_char(s."bucket", 'YYYY-MM-DD') AS "periodStart",
               COALESCE(x."revenueCents", 0)::bigint AS "revenueCents",
               COALESCE(x."itemsSubtotalCents", 0)::bigint AS "itemsSubtotalCents",
               COALESCE(x."shippingCents", 0)::bigint AS "shippingCents",
               COALESCE(x."orderCount", 0)::bigint AS "orderCount"
        FROM "series" s
        LEFT JOIN "sales" x ON x."bucket" = s."bucket"
        ORDER BY s."bucket" ASC
      `,
    );

    const buckets: RevenueBucket[] = rows.map((row) => ({
      // Text, and a calendar date rather than an instant: handing back an
      // instant invites the browser to re-read it in ITS zone and draw the bar
      // in the previous week — the bug this whole module avoids server-side.
      periodStart: String(row.periodStart),
      revenueCents: toCount(row.revenueCents),
      itemsSubtotalCents: toCount(row.itemsSubtotalCents),
      shippingCents: toCount(row.shippingCents),
      orderCount: toCount(row.orderCount),
    }));

    return {
      from: window.from,
      to: window.to,
      granularity,
      timeZone: zone,
      buckets,
    };
  }

  async carts() {
    const rows = await this.prisma.$queryRaw<Record<string, unknown>[]>(
      Prisma.sql`
        SELECT COALESCE(SUM(ci."quantity"), 0)::bigint AS "unitCount",
               COUNT(*)::bigint AS "lineCount",
               -- From the LINES, never from "carts": checkout consumes the
               -- items and leaves the cart row alive and empty, so counting
               -- carts would count everyone who ever bought once.
               COUNT(DISTINCT ci."cart_id")::bigint AS "cartCount"
        FROM "cart_items" ci
      `,
    );

    const row = rows[0] ?? {};

    return {
      // Units, not lines: three of one size in one bag is 3, the same reading
      // CartResponse.itemCount already uses. The 409 on variant removal counts
      // LINES, which is a different question about a different scope.
      unitCount: toCount(row.unitCount),
      lineCount: toCount(row.lineCount),
      cartCount: toCount(row.cartCount),
    };
  }

  async unsoldProducts(input: PaginatedReportInput) {
    const window = resolveWindow(input);
    const { page, perPage, skip } = paginate(input);
    const candidates = this.unsoldCandidates(window);

    const [rows, totals] = await this.prisma.$transaction([
      this.prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        ${candidates}
        SELECT p."id" AS "productId",
               p."name" AS "name",
               p."slug" AS "slug",
               st."stockQuantity" AS "stockQuantity",
               -- Formatted here rather than parsed by the driver, which reads
               -- a naive TIMESTAMP through the process's own offset.
               to_char(ls."lastSoldAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSoldAt"
        FROM "unsold" u
        JOIN "products" p ON p."id" = u."id"
        JOIN "stock" st ON st."product_id" = p."id"
        LEFT JOIN "last_sale" ls ON ls."product_id" = p."id"
        -- Most capital sitting still first: that is the piece a discount is
        -- decided about. Ties break on id so the page is stable.
        ORDER BY st."stockQuantity" DESC, p."id" ASC
        LIMIT ${perPage} OFFSET ${skip}
      `),
      this.prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        ${candidates}
        SELECT COUNT(*)::bigint AS "total" FROM "unsold"
      `),
    ]);

    const items: UnsoldProductRow[] = rows.map((row) => ({
      productId: String(row.productId),
      name: String(row.name),
      slug: String(row.slug),
      stockQuantity: toCount(row.stockQuantity),
      lastSoldAt: toInstant(row.lastSoldAt),
    }));

    return {
      from: window.from,
      to: window.to,
      items,
      total: toCount(totals[0]?.total),
      page,
      perPage,
    };
  }

  /**
   * The WHERE both halves of "a sale in this window" share.
   *
   * Written once and composed into four queries, so the status list and the
   * half-open window cannot drift apart between the page and its count.
   *
   * The window is bound as naive UTC text: `paid_at` is TIMESTAMP(3) WITHOUT
   * time zone, and a bound Date would be serialised with the process's offset,
   * which `::timestamp` then discards in silence.
   */
  private soldInWindow(window: ReportWindow): Prisma.Sql {
    return Prisma.sql`
      o."status"::text IN (${Prisma.join([...SOLD_STATUSES])})
      AND o."paid_at" >= ${toNaiveUtc(window.from)}::timestamp
      AND o."paid_at" < ${toNaiveUtc(window.to)}::timestamp
    `;
  }

  /**
   * Truncates a timestamp to its week or month IN THE STORE'S ZONE.
   *
   * Both `AT TIME ZONE`s are load-bearing, and the first one is the half that
   * is easy to leave out. `paid_at` is a NAIVE timestamp holding a UTC
   * reading, so `paid_at AT TIME ZONE 'America/Sao_Paulo'` does not convert it
   * FROM UTC — it declares that the reading was already São Paulo's and hands
   * back a timestamptz. The error is three hours, in the wrong direction, and
   * invisible to any test written around midday.
   *
   * `AT TIME ZONE 'UTC'` anchors the naive column to a real instant first;
   * only then does the second one move it to the store's wall clock.
   *
   * Postgres cuts weeks on Monday (ISO), which is what `periodStart` promises.
   */
  private bucketOf(
    timestamp: Prisma.Sql,
    granularity: RevenueGranularity,
  ): Prisma.Sql {
    return Prisma.sql`date_trunc(${granularity}, (${timestamp} AT TIME ZONE 'UTC') AT TIME ZONE ${this.timeZone})`;
  }

  /**
   * The CTEs behind "not moving": ACTIVE, holding stock, and absent from the
   * period's sales — plus the last time each one sold, of any era, so the
   * panel can tell "never" from "not since March".
   *
   * Shared between the page and its count for the same reason as
   * soldInWindow: two copies of this would be two definitions of stale.
   */
  private unsoldCandidates(window: ReportWindow): Prisma.Sql {
    const sold = this.soldInWindow(window);

    return Prisma.sql`
      WITH "stock" AS (
        SELECT v."product_id", SUM(v."stock_quantity")::bigint AS "stockQuantity"
        FROM "product_variants" v
        GROUP BY v."product_id"
      ),
      "sold_in_window" AS (
        SELECT DISTINCT oi."product_id"
        FROM "order_items" oi
        JOIN "orders" o ON o."id" = oi."order_id"
        WHERE ${sold}
      ),
      "last_sale" AS (
        SELECT oi."product_id", MAX(o."paid_at") AS "lastSoldAt"
        FROM "order_items" oi
        JOIN "orders" o ON o."id" = oi."order_id"
        WHERE o."status"::text IN (${Prisma.join([...SOLD_STATUSES])})
        GROUP BY oi."product_id"
      ),
      "unsold" AS (
        SELECT p."id"
        FROM "products" p
        JOIN "stock" st ON st."product_id" = p."id"
        WHERE p."status"::text = ${ProductStatus.ACTIVE}
          -- Sold out is not "not moving" — it is the opposite of it.
          AND st."stockQuantity" > 0
          AND p."id" NOT IN (SELECT "product_id" FROM "sold_in_window")
      )
    `;
  }
}
