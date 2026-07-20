// Deno Deploy v2 analytics → org usage totals + estimated Pro-plan spend.
//
// PURE (no I/O). The impure adapter fetches `GET /v2/apps/{appId}/analytics`
// per app and hands the raw `{ fields, values }` here to be summed; this module
// also turns a cycle-to-date total into an estimated USD spend.
//
// ⚠️ The $ figure is an ESTIMATE: usage × Deno's list overage prices, past the
// Pro allotments. It will NOT match the invoice exactly — calibrate PRO_PLAN
// against the dashboard and revisit if Deno changes pricing. Deno's own
// 50/90/100% spend-limit emails remain the source of truth for the hard cap.

/** One column descriptor from a v2 analytics response. */
export interface AnalyticsField {
  name: string;
  type: "time" | "number";
}

/** A v2 analytics response for one app: column descriptors + rows aligned to
 *  them (each row is `[isoTime, n, n, …]`, positionally matching `fields`). */
export interface AnalyticsResponse {
  fields: AnalyticsField[];
  values: Array<Array<string | number>>;
}

/** The metered dimensions we track, by their v2 analytics field name. */
export const METRICS = [
  "request_count",
  "network_egress_bytes",
  "cpu_seconds",
  "memory_time_byte_seconds",
  "kv_read_units",
  "kv_write_units",
] as const;
export type Metric = typeof METRICS[number];

const METRIC_SET: ReadonlySet<string> = new Set(METRICS);

function zeroTotals(): Record<Metric, number> {
  return Object.fromEntries(METRICS.map((m) => [m, 0])) as Record<Metric, number>;
}

/**
 * Sum each tracked metric's column across every row of ONE app's analytics
 * response. Columns are matched by field name (not position), so an added or
 * reordered field can't silently shift a total; unknown/absent metrics stay 0.
 */
export function sumAnalytics(res: AnalyticsResponse): Record<Metric, number> {
  const colIndex: Partial<Record<Metric, number>> = {};
  res.fields.forEach((f, i) => {
    if (METRIC_SET.has(f.name)) colIndex[f.name as Metric] = i;
  });
  const totals = zeroTotals();
  for (const row of res.values) {
    for (const m of METRICS) {
      const i = colIndex[m];
      if (i === undefined) continue;
      const v = row[i];
      if (typeof v === "number" && Number.isFinite(v)) totals[m] += v;
    }
  }
  return totals;
}

/** Merge several apps' summed totals into one org-wide total. */
export function mergeTotals(perApp: Array<Record<Metric, number>>): Record<Metric, number> {
  const out = zeroTotals();
  for (const t of perApp) {
    for (const m of METRICS) out[m] += t[m] ?? 0;
  }
  return out;
}

/** One app's slice of the digest, in display units. */
export interface AppUsage {
  app: string;
  requests: number;
  kvReadUnits: number;
  kvWriteUnits: number;
  egressGB: number;
  cpuHours: number;
  memoryGBHours: number;
  /** True when at least one analytics chunk for this app failed, so its numbers
   *  are known-incomplete rather than genuinely zero. */
  errored?: boolean;
}

function round(n: number, dp: number): number {
  return Number(n.toFixed(dp));
}

/** Convert one app's raw metric totals into the digest's display units. */
export function toAppUsage(app: string, t: Record<Metric, number>, errored = false): AppUsage {
  return {
    app,
    requests: t.request_count,
    kvReadUnits: t.kv_read_units,
    kvWriteUnits: t.kv_write_units,
    egressGB: round(t.network_egress_bytes / 1e9, 3),
    cpuHours: round(t.cpu_seconds / 3600, 2),
    memoryGBHours: round(t.memory_time_byte_seconds / (1e9 * 3600), 1),
    ...(errored ? { errored: true } : {}),
  };
}

/** Busiest first, so the interesting apps head the list and the email. Ties
 *  break on KV reads then name, so the order is stable run to run. */
export function rankApps(apps: AppUsage[]): AppUsage[] {
  return [...apps].sort((a, b) =>
    b.requests - a.requests || b.kvReadUnits - a.kvReadUnits || a.app.localeCompare(b.app)
  );
}

/** Thousands separators, so a 6-figure KV count is readable at a glance. */
function group(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Render the per-app table as fixed-width text for an alert body — the digest's
 * `{breakdown}` capture. Apps with no traffic at all are collapsed into a
 * trailing "+N idle" line rather than padding the email with zero rows.
 * `limit` caps the listed rows (the rest roll into an "+N more" line) so a large
 * org can't produce an unreadable wall of text or blow the capture size cap.
 */
export function formatBreakdown(apps: AppUsage[], limit = 15): string {
  const ranked = rankApps(apps);
  const active = ranked.filter((a) => a.requests > 0 || a.kvReadUnits > 0 || a.kvWriteUnits > 0);
  const idle = ranked.length - active.length;
  const shown = active.slice(0, Math.max(0, limit));

  const lines: string[] = [];
  if (shown.length > 0) {
    // Right-align each numeric column to its widest value so the columns line up
    // in a monospaced mail client.
    const w = (pick: (a: AppUsage) => string) => Math.max(...shown.map((a) => pick(a).length));
    const nameW = w((a) => a.app);
    const reqW = w((a) => group(a.requests));
    const readW = w((a) => group(a.kvReadUnits));
    const writeW = w((a) => group(a.kvWriteUnits));
    for (const a of shown) {
      lines.push(
        `${a.app.padEnd(nameW)}  ${group(a.requests).padStart(reqW)} req  ` +
          `${group(a.kvReadUnits).padStart(readW)} KVr  ` +
          `${group(a.kvWriteUnits).padStart(writeW)} KVw` +
          (a.errored ? "  ⚠️ partial" : ""),
      );
    }
  }
  const more = active.length - shown.length;
  if (more > 0) lines.push(`+${more} more`);
  if (idle > 0) lines.push(`+${idle} idle`);
  return lines.join("\n") || "(no activity)";
}

/** Cost model for one metered dimension. */
export interface DimensionCost {
  /** Included free each billing cycle, in the billable unit `toUnits` yields. */
  allotment: number;
  /** Overage price per billable unit, USD. */
  pricePerUnit: number;
  /** Convert a raw analytics total to the billable unit (e.g. bytes → GB). */
  toUnits: (raw: number) => number;
}

export type PlanCosts = Record<Metric, DimensionCost>;

// Deno Deploy **Pro** list values as of 2026-07 (deno.com/deploy/pricing).
// Overage PRICES are published; several ALLOTMENTS (esp. KV read/write units)
// are placeholders that MUST be calibrated against the dashboard — see the plan.
// KV allotments default to 0 (every unit billed) so a pre-calibration estimate
// OVER-states spend → the guardrail errs toward an early alert, never a missed one.
export const PRO_PLAN: PlanCosts = {
  request_count: { allotment: 5_000_000, pricePerUnit: 2 / 1_000_000, toUnits: (r) => r },
  network_egress_bytes: { allotment: 200, pricePerUnit: 0.5, toUnits: (r) => r / 1e9 }, // → GB
  cpu_seconds: { allotment: 40, pricePerUnit: 0.05, toUnits: (r) => r / 3600 }, // → CPU-hours
  memory_time_byte_seconds: { allotment: 1000, pricePerUnit: 0.016, toUnits: (r) => r / (1e9 * 3600) }, // → GB-hours
  kv_read_units: { allotment: 0 /* CALIBRATE */, pricePerUnit: 1 / 1_000_000, toUnits: (r) => r },
  kv_write_units: { allotment: 0 /* CALIBRATE */, pricePerUnit: 2.5 / 1_000_000, toUnits: (r) => r },
};

/**
 * Estimate USD spend for a cycle-to-date usage total: a flat base fee plus, for
 * each dimension, the overage (usage past allotment) × its price. `baseUSD` is
 * the plan's fixed monthly fee (0 to estimate overage-only).
 */
export function estimateSpendUSD(
  cycleTotals: Record<Metric, number>,
  plan: PlanCosts = PRO_PLAN,
  baseUSD = 0,
): number {
  let spend = baseUSD;
  for (const m of METRICS) {
    const d = plan[m];
    const units = d.toUnits(cycleTotals[m] ?? 0);
    spend += Math.max(0, units - d.allotment) * d.pricePerUnit;
  }
  return spend;
}

/** Spend as a percent of a budget. A non-positive budget yields 0 (undefined ratio). */
export function pctOfBudget(spendUSD: number, budgetUSD: number): number {
  if (!(budgetUSD > 0)) return 0;
  return (spendUSD / budgetUSD) * 100;
}
