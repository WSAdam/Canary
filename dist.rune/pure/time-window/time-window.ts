// Resolving and displaying the usage digest's reporting window. PURE (no I/O)
// apart from reading the caller-supplied params.
//
// Everything crossing a boundary (the API, the stored DTO) stays a UTC ISO
// instant — unambiguous. Only the DISPLAY strings are zoned, because a digest
// that says "15:45" when you read it at 11:45 is worse than useless.

import { CanaryError } from "../../dto/_shared.ts";

/** The report's display timezone. Deno Deploy runs UTC; the reader doesn't. */
export const DISPLAY_TZ = "America/New_York";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  abbrev: string;
}

/** Break an instant into its wall-clock parts in `tz`, plus the zone's
 *  abbreviation at that instant (EST vs EDT — which one matters to a reader). */
function partsIn(instant: Date, tz: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(instant)) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    // hourCycle h23 still renders midnight as "24" in some ICU versions.
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
    abbrev: p.timeZoneName ?? "",
  };
}

/** How far `tz` is from UTC at `instant`, in ms (negative west of Greenwich). */
function offsetMsAt(instant: Date, tz: string): number {
  const p = partsIn(instant, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime();
}

/**
 * Turn a WALL-CLOCK time in `tz` into the real UTC instant. The offset itself
 * depends on the instant (DST), so the naive guess is corrected once against
 * the offset actually in force there — which is what makes a window like
 * "yesterday 00:00 ET" land correctly on a spring-forward/fall-back day.
 */
export function zonedToInstant(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
  tz: string = DISPLAY_TZ,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const corrected = guess - offsetMsAt(new Date(guess), tz);
  // Re-derive from the corrected instant: across a DST transition the first
  // offset can be the wrong side of the boundary.
  return new Date(guess - offsetMsAt(new Date(corrected), tz));
}

/** An instant as `HH:MM DD/Month/YYYY TZ`, e.g. `12:01 19/July/2026 EDT`. */
export function formatDisplay(instant: Date, tz: string = DISPLAY_TZ): string {
  const p = partsIn(instant, tz);
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return `${hh}:${mm} ${p.day}/${MONTHS[p.month - 1]}/${p.year} ${p.abbrev}`.trim();
}

/** A compact range label. Collapses the date when both ends fall on the same
 *  local day — `19/July/2026 00:00 → 23:59 EDT` reads better than repeating it. */
export function formatRange(since: Date, until: Date, tz: string = DISPLAY_TZ): string {
  const a = partsIn(since, tz);
  const b = partsIn(until, tz);
  const hm = (p: ZonedParts) => `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const date = (p: ZonedParts) => `${p.day}/${MONTHS[p.month - 1]}/${p.year}`;
  return a.year === b.year && a.month === b.month && a.day === b.day
    ? `${date(a)} ${hm(a)} → ${hm(b)} ${b.abbrev}`
    : `${date(a)} ${hm(a)} → ${date(b)} ${hm(b)} ${b.abbrev}`;
}

/** An instant's local calendar date as `YYYY-MM-DD` — the key rows are bucketed
 *  into so a "day" means the reader's day, not UTC's. */
export function dayKey(instant: Date, tz: string = DISPLAY_TZ): string {
  const p = partsIn(instant, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** A short local date for a table row, e.g. `Sun 19/July`. */
export function dayLabel(instant: Date, tz: string = DISPLAY_TZ): string {
  const p = partsIn(instant, tz);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(instant);
  return `${weekday} ${p.day}/${MONTHS[p.month - 1]}`;
}

/** The `count` complete local days ending `endOffset` days back from `now`
 *  (endOffset 1 = ending yesterday), oldest first — the trailing series. */
export function trailingDays(
  now: Date,
  count: number,
  endOffset = 1,
  tz: string = DISPLAY_TZ,
): Array<TimeWindow & { key: string; label: string }> {
  const out: Array<TimeWindow & { key: string; label: string }> = [];
  for (let i = count - 1 + endOffset; i >= endOffset; i--) {
    const w = localDay(now, i, tz);
    out.push({ ...w, key: dayKey(w.since, tz), label: dayLabel(w.since, tz) });
  }
  return out;
}

/** A resolved reporting window: UTC instants plus their display strings. */
export interface TimeWindow {
  since: Date;
  until: Date;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Parse one `from`/`to` value. A bare date or date+time carries no zone, and
 * the reader thinks in local time — so it is read as DISPLAY_TZ wall-clock, NOT
 * UTC. An explicit offset or trailing Z is honoured as written.
 */
export function parseBoundary(raw: string, field: string, tz: string = DISPLAY_TZ): Date {
  const s = raw.trim();
  const dOnly = DATE_ONLY.exec(s);
  if (dOnly) return zonedToInstant(+dOnly[1], +dOnly[2], +dOnly[3], 0, 0, 0, 0, tz);
  const dt = DATE_TIME.exec(s);
  if (dt) return zonedToInstant(+dt[1], +dt[2], +dt[3], +dt[4], +dt[5], dt[6] ? +dt[6] : 0, 0, tz);
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) {
    throw new CanaryError(
      "validation-error",
      `Invalid ${field} "${raw}" — expected YYYY-MM-DD, "YYYY-MM-DD HH:MM" (${tz}), or a full ISO timestamp`,
      400,
    );
  }
  return parsed;
}

/** The whole of a local day, `dayOffset` days back from `now` (0 = today).
 *  A day still in progress is clamped to `now`, so a partial day reports (and
 *  LABELS) only the hours that have actually elapsed rather than claiming a
 *  range running to midnight. */
export function localDay(now: Date, dayOffset: number, tz: string = DISPLAY_TZ): TimeWindow {
  const p = partsIn(now, tz);
  const start = zonedToInstant(p.year, p.month, p.day, 0, 0, 0, 0, tz);
  const shifted = partsIn(new Date(start.getTime() - dayOffset * 86_400_000), tz);
  const since = zonedToInstant(shifted.year, shifted.month, shifted.day, 0, 0, 0, 0, tz);
  // End of day is the last millisecond, so a "yesterday" window can't bleed a
  // request from 00:00:00.000 today into yesterday's numbers.
  const endOfDay = new Date(
    zonedToInstant(shifted.year, shifted.month, shifted.day, 23, 59, 59, 0, tz).getTime() + 999,
  );
  return { since, until: endOfDay.getTime() > now.getTime() ? now : endOfDay };
}

// A window longer than this is almost certainly a typo (a swapped year, a
// stray digit) and would fan out into a very large number of chunked API
// calls, so it's rejected rather than quietly hammering the analytics endpoint.
const MAX_WINDOW_DAYS = 92;

/**
 * Resolve the reporting window from a check's query params, in precedence
 * order: `day` (relative — the right choice for a RECURRING report, since an
 * absolute range would freeze on one date forever), then explicit
 * `from`/`to`, then a rolling `hours` window (the default).
 */
export function resolveWindow(params: URLSearchParams, now: Date = new Date(), tz: string = DISPLAY_TZ): TimeWindow {
  const day = params.get("day")?.trim().toLowerCase();
  if (day) {
    const offsets: Record<string, number> = { today: 0, yesterday: 1 };
    if (!Object.hasOwn(offsets, day)) {
      throw new CanaryError("validation-error", `Unknown day "${day}" — expected "today" or "yesterday"`, 400);
    }
    return localDay(now, offsets[day], tz);
  }

  const from = params.get("from");
  const to = params.get("to");
  if (from || to) {
    if (!from || !to) {
      throw new CanaryError("validation-error", `"from" and "to" must be given together`, 400);
    }
    const since = parseBoundary(from, "from", tz);
    const until = parseBoundary(to, "to", tz);
    if (until.getTime() <= since.getTime()) {
      throw new CanaryError("validation-error", `"to" must be after "from"`, 400);
    }
    if (until.getTime() - since.getTime() > MAX_WINDOW_DAYS * 86_400_000) {
      throw new CanaryError("validation-error", `Window exceeds the ${MAX_WINDOW_DAYS}-day maximum`, 400);
    }
    return { since, until };
  }

  const raw = Number(params.get("hours"));
  const hours = Number.isFinite(raw) && raw > 0 && raw <= 744 ? raw : 24;
  return { since: new Date(now.getTime() - hours * 3_600_000), until: now };
}
