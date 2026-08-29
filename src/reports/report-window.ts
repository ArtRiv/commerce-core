import { BadRequestException } from '@nestjs/common';

/**
 * The reporting window, in one place, because three of the four routes take
 * the same one and a period that means slightly different things per route is
 * how two dashboard tiles end up disagreeing.
 *
 * See docs/specs/reports.md, invariant 3.
 */

/** What a caller omitting `from` gets: the last month, ending at `to`. */
export const DEFAULT_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReportWindowInput {
  from?: string;
  to?: string;
}

/** Half-open: `from` inclusive, `to` exclusive. */
export interface ReportWindow {
  from: Date;
  to: Date;
}

function parse(label: string, value: string): Date {
  const parsed = new Date(value);

  // The DTO's @IsDateString already refuses this; the second check is here
  // because resolveWindow is also called from the tests and from anywhere a
  // future route forgets the decorator.
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${label} is not a valid ISO-8601 date`);
  }

  return parsed;
}

/**
 * Fills in whichever end the caller left out, and refuses a window that
 * cannot contain anything.
 *
 * `to` is EXCLUSIVE, which is what stops August and September counting the
 * same order twice when a panel asks for both. `from === to` is therefore
 * empty rather than "one instant", and empty is refused for the same reason
 * `minPriceCents > maxPriceCents` is refused on GET /products: an impossible
 * range is the caller's bug, and answering [] hides it behind something that
 * reads as "nothing matched".
 */
export function resolveWindow(
  input: ReportWindowInput,
  now: Date = new Date(),
): ReportWindow {
  const to = input.to === undefined ? now : parse('to', input.to);
  const from =
    input.from === undefined
      ? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS)
      : parse('from', input.from);

  if (from.getTime() >= to.getTime()) {
    throw new BadRequestException(
      'from must be earlier than to — the window is [from, to), so an empty one matches nothing',
    );
  }

  return { from, to };
}

/**
 * Renders an instant as the UTC wall clock, with NO zone suffix.
 *
 * `orders.paid_at` is `TIMESTAMP(3)` *without* time zone — what Prisma emits —
 * holding a UTC reading. Binding a `Date` would let the driver serialise it
 * with the process's own offset, and the `::timestamp` cast on the other side
 * discards an offset silently: the window's edges would then move by however
 * the server happens to be configured, with nothing anywhere to say so.
 *
 * So the offset is removed here, deliberately and visibly, instead.
 */
export function toNaiveUtc(date: Date): string {
  // toISOString is always UTC and always this exact shape; dropping the
  // trailing 'Z' is what turns an instant into the naive reading the column
  // stores.
  return date.toISOString().slice(0, -1);
}
