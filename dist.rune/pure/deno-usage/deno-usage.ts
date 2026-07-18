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
