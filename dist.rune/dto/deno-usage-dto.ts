/** The `/api/deno-usage` response: org-wide Deno Deploy usage over a window,
 *  summed across every app. Flat numeric fields so a Canary check can extract
 *  any of them by dot-path (observed) or capture (`{kvReads}` etc.). */
import type { AppUsage, DayUsage, PerAppSeries, TrendComparison, TrendKey } from "../pure/deno-usage/deno-usage.ts";

export interface DenoUsageDto {
  ok: true;
  window: {
    /** UTC ISO instants — unambiguous, for machines. */
    since: string;
    until: string;
    /** Window length in hours (fractional for a partial-day range). */
    hours: number;
    /** The same bounds for a human, `HH:MM DD/Month/YYYY TZ` in Eastern time. */
    sinceLocal: string;
    untilLocal: string;
    /** Both bounds as one compact label, for a `{window}` capture. */
    label: string;
  };
  /** How many apps were summed (and how many analytics calls failed, if any). */
  apps: number;
  appsErrored: number;
  requests: number;
  kvReadUnits: number;
  kvWriteUnits: number;
  egressGB: number;
  cpuHours: number;
  memoryGBHours: number;
  /** Of `apps`, how many did anything at all in the window (and how many sat
   *  dormant). `appsActive` is `byApp.length`. */
  appsActive: number;
  appsIdle: number;
  /** The same metrics per app, busiest first, **excluding apps with no activity
   *  at all** — a row of zeroes is noise (see `appsIdle` for the count). Capture
   *  a single app by index (`byApp.0.requests`) or the whole array (it
   *  serializes to JSON). */
  byApp: AppUsage[];
  /** The window's metered usage priced at **list rate**: the org total, the
   *  split by dimension, and that rate extrapolated to a month.
   *
   *  Deliberately ignores the plan's monthly included allotments (org-wide, so
   *  not attributable to one app-day) and excludes the fixed plan fee and any
   *  provisioned database/storage. It answers "which app costs what", NOT "what
   *  is the bill" — in practice the metered slice is a small fraction of it.
   *  For real dollars use the spend guardrail (`internal:deno-spend`). */
  cost: {
    totalUSD: number;
    byMetric: Record<string, number>;
    projectedMonthlyUSD: number;
  };
  /** `byApp` pre-rendered as a fixed-width text table, for an alert body's
   *  `{breakdown}` capture — an array capture would render as raw JSON. */
  breakdown: string;
  /** Present when `?trailing=N` is requested: the N complete days ending with
   *  the reporting day, plus how the latest compares to the rest. */
  trailing?: {
    days: number;
    /** Oldest first, so the most recent day reads last. */
    series: DayUsage[];
    /** Each active app's day-by-day requests/KV/cost, arrays aligned to
     *  `series`, busiest first. Feeds the by-app trend matrices. */
    perApp: PerAppSeries[];
    /** Per-metric change of the latest day vs the prior day and vs the average
     *  of the preceding days (null where there's no meaningful baseline). */
    comparison: Record<TrendKey, TrendComparison>;
    /** The series pre-rendered as a fixed-width table with the deltas. */
    table: string;
  };
  /** The whole email body — reporting day, per-app breakdown, and the trailing
   *  trend — assembled ready for a single `{report}` capture (plain text). */
  report: string;
  /** The same report as an HTML fragment — real tables that survive Gmail's
   *  proportional font, delta arrows colored, plus per-app requests/cost
   *  matrices across the trailing days. Capture as `{reportHtml}` and make it
   *  the entire email message; the email channel detects HTML and sends it as
   *  HtmlBody. */
  reportHtml: string;
}
