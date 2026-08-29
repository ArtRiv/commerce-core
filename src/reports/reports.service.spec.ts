import type { ConfigService } from '@nestjs/config';

import { Prisma } from '../generated/prisma/client';
import { OrderStatus, ProductStatus } from '../generated/prisma/enums';
import type { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from './reports.service';

function createPrismaMock() {
  const client = {
    /**
     * Every query in this module is raw, and every one is built as a
     * `Prisma.sql` value rather than a tagged template — which is what lets
     * these tests read back the SQL AND the bound parameters, and assert that
     * a CREATED order never reaches the database as something to count.
     */
    $queryRaw: jest
      .fn<Promise<unknown[]>, [Prisma.Sql]>()
      .mockResolvedValue([]),
    $transaction: jest.fn((queries: Promise<unknown>[]): Promise<unknown[]> =>
      Promise.all(queries),
    ),
  };

  return client;
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

function configWith(timeZone?: string): ConfigService {
  return {
    get: jest.fn((key: string) =>
      key === 'REPORTS_TIMEZONE' ? timeZone : undefined,
    ),
  } as unknown as ConfigService;
}

function serviceWith(prisma: PrismaMock, timeZone?: string): ReportsService {
  return new ReportsService(
    prisma as unknown as PrismaService,
    configWith(timeZone),
  );
}

/** The Sql of the nth $queryRaw call, for reading its text and its values. */
function queryAt(prisma: PrismaMock, index: number): Prisma.Sql {
  const call = prisma.$queryRaw.mock.calls.at(index);

  if (!call) {
    throw new Error(`No query was issued at index ${String(index)}`);
  }

  return call[0];
}

const WINDOW = {
  from: '2026-08-01T00:00:00.000Z',
  to: '2026-09-01T00:00:00.000Z',
};

describe('ReportsService', () => {
  describe('the definition of a sale', () => {
    /**
     * The single most important assertion in this file. Every route shares one
     * SOLD_STATUSES constant, and this proves what is in it — from the values
     * actually bound to the query, not from a copy of the list.
     *
     * CREATED is stock that left the shelf with no money behind it, and half
     * of them never get paid. CANCELLED and REFUNDED both restock. None of the
     * three is revenue. See docs/specs/reports.md, invariant 1.
     */
    it.each([
      ['productSales', (s: ReportsService) => s.productSales(WINDOW)],
      ['revenue', (s: ReportsService) => s.revenue(WINDOW)],
      ['unsoldProducts', (s: ReportsService) => s.unsoldProducts(WINDOW)],
    ])('counts only PAID, SHIPPED and DELIVERED in %s', async (_, call) => {
      const prisma = createPrismaMock();
      await call(serviceWith(prisma));

      const bound = queryAt(prisma, 0).values;

      expect(bound).toContain(OrderStatus.PAID);
      expect(bound).toContain(OrderStatus.SHIPPED);
      expect(bound).toContain(OrderStatus.DELIVERED);

      expect(bound).not.toContain(OrderStatus.CREATED);
      expect(bound).not.toContain(OrderStatus.CANCELLED);
      expect(bound).not.toContain(OrderStatus.REFUNDED);
    });

    /** Revenue happens when the money lands, not when the cart froze. */
    it('reads the clock from paid_at, never created_at', async () => {
      const prisma = createPrismaMock();
      await serviceWith(prisma).revenue(WINDOW);

      const { sql } = queryAt(prisma, 0);

      expect(sql).toContain('paid_at');
      expect(sql).not.toContain('created_at');
    });
  });

  describe('productSales', () => {
    it('turns the bigint aggregates into numbers, and echoes the window', async () => {
      const prisma = createPrismaMock();
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            productId: 'product-1',
            name: 'Camiseta Preta',
            slug: 'camiseta-preta',
            unitsSold: 7n,
            itemsRevenueCents: 55930n,
            orderCount: 4n,
          },
        ])
        .mockResolvedValueOnce([{ total: 1n }]);

      const report = await serviceWith(prisma).productSales(WINDOW);

      expect(report.items).toEqual([
        {
          productId: 'product-1',
          name: 'Camiseta Preta',
          slug: 'camiseta-preta',
          unitsSold: 7,
          itemsRevenueCents: 55930,
          orderCount: 4,
        },
      ]);
      expect(report.total).toBe(1);
      expect(report.from).toEqual(new Date(WINDOW.from));
      expect(report.to).toEqual(new Date(WINDOW.to));
    });

    /**
     * The window is bound with no zone suffix, because paid_at is a naive
     * TIMESTAMP holding a UTC reading — see report-window.toNaiveUtc.
     */
    it('binds the window as a naive UTC wall clock', async () => {
      const prisma = createPrismaMock();
      await serviceWith(prisma).productSales(WINDOW);

      const bound = queryAt(prisma, 0).values;

      expect(bound).toContain('2026-08-01T00:00:00.000');
      expect(bound).toContain('2026-09-01T00:00:00.000');
      expect(bound).not.toContain('2026-08-01T00:00:00.000Z');
    });

    it('groups by product id, so a renamed piece stays one line', async () => {
      const prisma = createPrismaMock();
      await serviceWith(prisma).productSales(WINDOW);

      const { sql } = queryAt(prisma, 0);

      expect(sql).toContain('GROUP BY');
      expect(sql).toContain('product_id');
      // The name comes from the live catalogue, not from the order's snapshot.
      expect(sql).not.toContain('product_name');
    });

    it('clamps perPage to 100 and refuses a page below the first', async () => {
      const prisma = createPrismaMock();
      const report = await serviceWith(prisma).productSales({
        ...WINDOW,
        page: 0,
        perPage: 5000,
      });

      expect(report.page).toBe(1);
      expect(report.perPage).toBe(100);
      expect(queryAt(prisma, 0).values).toContain(100);
    });

    it('answers an empty period with an empty page, not an error', async () => {
      const prisma = createPrismaMock();
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0n }]);

      const report = await serviceWith(prisma).productSales(WINDOW);

      expect(report.items).toEqual([]);
      expect(report.total).toBe(0);
    });
  });

  describe('revenue', () => {
    it('defaults to months', async () => {
      const prisma = createPrismaMock();
      const report = await serviceWith(prisma).revenue(WINDOW);

      expect(report.granularity).toBe('month');
      expect(queryAt(prisma, 0).values).toContain('month');
    });

    it('cuts the buckets in the configured zone, and reports which', async () => {
      const prisma = createPrismaMock();
      const report = await serviceWith(prisma, 'America/Sao_Paulo').revenue({
        ...WINDOW,
        granularity: 'week',
      });

      expect(report.timeZone).toBe('America/Sao_Paulo');
      expect(queryAt(prisma, 0).values).toContain('America/Sao_Paulo');
    });

    it('falls back to UTC when the instance configured no zone', async () => {
      const prisma = createPrismaMock();

      expect((await serviceWith(prisma).revenue(WINDOW)).timeZone).toBe('UTC');
    });

    /**
     * Both halves of invariant 4. `AT TIME ZONE 'UTC'` anchors the naive
     * column to an instant; only then does the second one move it to the
     * store's wall clock. The short form alone is wrong by the offset, in the
     * opposite direction, and silently.
     */
    it("anchors the naive column in UTC before moving it to the store's zone", async () => {
      const prisma = createPrismaMock();
      await serviceWith(prisma, 'America/Sao_Paulo').revenue(WINDOW);

      expect(queryAt(prisma, 0).sql).toContain(
        `AT TIME ZONE 'UTC') AT TIME ZONE`,
      );
    });

    it('maps a bucket, and its total is items plus freight', async () => {
      const prisma = createPrismaMock();
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          periodStart: '2026-08-01',
          revenueCents: 59920n,
          itemsSubtotalCents: 55930n,
          shippingCents: 3990n,
          orderCount: 4n,
        },
      ]);

      const [bucket] = (await serviceWith(prisma).revenue(WINDOW)).buckets;

      expect(bucket).toEqual({
        periodStart: '2026-08-01',
        revenueCents: 59920,
        itemsSubtotalCents: 55930,
        shippingCents: 3990,
        orderCount: 4,
      });
      expect(bucket.revenueCents).toBe(
        bucket.itemsSubtotalCents + bucket.shippingCents,
      );
    });

    /** A bar chart that skips the bad week draws a store that was closed. */
    it('builds the series from the calendar, so quiet weeks are zeros', async () => {
      const prisma = createPrismaMock();
      await serviceWith(prisma).revenue(WINDOW);

      const { sql } = queryAt(prisma, 0);

      expect(sql).toContain('generate_series');
      expect(sql).toContain('LEFT JOIN');
    });

    it('does not paginate — a chart needs the whole series', async () => {
      const prisma = createPrismaMock();
      await serviceWith(prisma).revenue(WINDOW);

      expect(queryAt(prisma, 0).sql).not.toContain('LIMIT');
    });
  });

  describe('carts', () => {
    it('counts units, lines and the carts holding them', async () => {
      const prisma = createPrismaMock();
      prisma.$queryRaw.mockResolvedValueOnce([
        { unitCount: 40n, lineCount: 12n, cartCount: 2n },
      ]);

      expect(await serviceWith(prisma).carts()).toEqual({
        unitCount: 40,
        lineCount: 12,
        cartCount: 2,
      });
    });

    /**
     * Checkout consumes the items and leaves the cart row alive and empty, so
     * counting carts would count everyone who ever bought once. Counting the
     * carts that own a LINE is what makes the number mean "right now".
     */
    it('takes the cart count from the lines, never from the carts table', async () => {
      const prisma = createPrismaMock();
      prisma.$queryRaw.mockResolvedValueOnce([
        { unitCount: 0n, lineCount: 0n, cartCount: 0n },
      ]);

      await serviceWith(prisma).carts();
      const { sql } = queryAt(prisma, 0);

      expect(sql).toContain('cart_items');
      expect(sql).not.toContain('FROM "carts"');
    });

    it('reads an empty database as three zeros', async () => {
      const prisma = createPrismaMock();
      prisma.$queryRaw.mockResolvedValueOnce([
        { unitCount: null, lineCount: 0n, cartCount: 0n },
      ]);

      expect(await serviceWith(prisma).carts()).toEqual({
        unitCount: 0,
        lineCount: 0,
        cartCount: 0,
      });
    });
  });

  describe('unsoldProducts', () => {
    it('parses the last sale, and leaves never-sold as null', async () => {
      const prisma = createPrismaMock();
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            productId: 'product-1',
            name: 'Camiseta Preta',
            slug: 'camiseta-preta',
            stockQuantity: 12n,
            lastSoldAt: '2026-05-04T18:30:00.000Z',
          },
          {
            productId: 'product-2',
            name: 'Calça Cargo',
            slug: 'calca-cargo',
            stockQuantity: 3n,
            lastSoldAt: null,
          },
        ])
        .mockResolvedValueOnce([{ total: 2n }]);

      const report = await serviceWith(prisma).unsoldProducts(WINDOW);

      expect(report.items[0].lastSoldAt).toEqual(
        new Date('2026-05-04T18:30:00.000Z'),
      );
      expect(report.items[0].stockQuantity).toBe(12);
      expect(report.items[1].lastSoldAt).toBeNull();
      expect(report.total).toBe(2);
    });

    it('asks only for ACTIVE pieces that still have stock', async () => {
      const prisma = createPrismaMock();
      await serviceWith(prisma).unsoldProducts(WINDOW);

      const query = queryAt(prisma, 0);

      expect(query.values).toContain(ProductStatus.ACTIVE);
      expect(query.sql).toContain('stock_quantity');
    });
  });
});
