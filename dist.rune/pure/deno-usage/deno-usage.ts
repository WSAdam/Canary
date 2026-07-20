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
  // Deliberately NOT sumAnalyticsWhere(res, () => true): that one drops a row
  // whose timestamp won't parse, because it can't tell whether the row belongs
  // in the window. Here there is no window, so every row counts.
  const cols = metricColumns(res);
  const totals = zeroTotals();
  for (const row of res.values) addRow(totals, row, cols);
  return totals;
}

/** Index of the response's time column, or -1 when it has none. */
function timeColumn(res: AnalyticsResponse): number {
  return res.fields.findIndex((f) => f.type === "time" || f.name === "time");
}

/** Map each metric to its column index, matching by NAME so an added or
 *  reordered field can't silently shift a total. */
function metricColumns(res: AnalyticsResponse): Partial<Record<Metric, number>> {
  const cols: Partial<Record<Metric, number>> = {};
  res.fields.forEach((f, i) => {
    if (METRIC_SET.has(f.name)) cols[f.name as Metric] = i;
  });
  return cols;
}

function addRow(totals: Record<Metric, number>, row: Array<string | number>, cols: Partial<Record<Metric, number>>) {
  for (const m of METRICS) {
    const i = cols[m];
    if (i === undefined) continue;
    const v = row[i];
    if (typeof v === "number" && Number.isFinite(v)) totals[m] += v;
  }
}

/**
 * Sum only the buckets whose timestamp `keep` accepts. Lets one fetched
 * response answer several questions — the primary window's totals AND each
 * day's — instead of re-fetching per window. A response with no time column
 * falls back to summing everything.
 */
export function sumAnalyticsWhere(res: AnalyticsResponse, keep: (timeMs: number) => boolean): Record<Metric, number> {
  const cols = metricColumns(res);
  const ti = timeColumn(res);
  const totals = zeroTotals();
  for (const row of res.values) {
    if (ti >= 0) {
      const t = Date.parse(String(row[ti]));
      if (!Number.isFinite(t) || !keep(t)) continue;
    }
    addRow(totals, row, cols);
  }
  return totals;
}

/**
 * Bucket the response's rows into per-day totals, keyed by whatever
 * `dayKeyOf` returns for each bucket's timestamp. The caller supplies the key
 * function so the timezone rule stays in one place (time-window) and this
 * module stays free of zone logic.
 */
export function sumAnalyticsByDay(
  res: AnalyticsResponse,
  dayKeyOf: (timeMs: number) => string,
): Record<string, Record<Metric, number>> {
  const cols = metricColumns(res);
  const ti = timeColumn(res);
  const out: Record<string, Record<Metric, number>> = {};
  if (ti < 0) return out; // no time column — days are unknowable
  for (const row of res.values) {
    const t = Date.parse(String(row[ti]));
    if (!Number.isFinite(t)) continue;
    const key = dayKeyOf(t);
    addRow(out[key] ??= zeroTotals(), row, cols);
  }
  return out;
}

/** Merge several apps' summed totals into one org-wide total. */
export function mergeTotals(perApp: Array<Record<Metric, number>>): Record<Metric, number> {
  const out = zeroTotals();
  for (const t of perApp) {
    for (const m of METRICS) out[m] += t[m] ?? 0;
  }
  return out;
}

/** What a slice of usage costs at list rate, split by dimension. */
export interface UsageCost {
  totalUSD: number;
  byMetric: Record<Metric, number>;
}

/** Human labels for the cost breakdown, in report order. */
export const COST_LABELS: Array<[Metric, string]> = [
  ["request_count", "Requests"],
  ["kv_read_units", "KV reads"],
  ["kv_write_units", "KV writes"],
  ["network_egress_bytes", "Egress"],
  ["cpu_seconds", "CPU"],
  ["memory_time_byte_seconds", "Memory"],
];

/**
 * Price a usage total at **list rate, ignoring allotments**.
 *
 * The plan's included allowances are ORG-WIDE and MONTHLY, so subtracting them
 * from one app's single day is meaningless — it would show most apps at $0 and
 * attribute the entire bill to whichever one happened to cross the line. This
 * answers "what did this usage cost", which is the question that makes per-app
 * and day-over-day comparison possible.
 *
 * It is NOT an invoice: it excludes the fixed plan fee and any provisioned
 * database/storage, which in practice dominate the real bill.
 */
export function listCost(t: Record<Metric, number>, plan: PlanCosts = PRO_PLAN): UsageCost {
  const byMetric = {} as Record<Metric, number>;
  let totalUSD = 0;
  for (const m of METRICS) {
    const c = plan[m].toUnits(t[m] ?? 0) * plan[m].pricePerUnit;
    byMetric[m] = c;
    totalUSD += c;
  }
  return { totalUSD, byMetric };
}

/** Money for a table cell. Daily per-app figures land in fractions of a cent,
 *  so 2dp would flatten every app to `$0.00`; `dp` widens where that matters. */
export function formatUSD(n: number, dp = 2): string {
  return `$${n.toFixed(dp)}`;
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
  /** This app's usage priced at list rate (see listCost) — for attribution,
   *  not billing. */
  costUSD: number;
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
    costUSD: round(listCost(t).totalUSD, 4),
    ...(errored ? { errored: true } : {}),
  };
}

/** Did this app do anything at all in the window? An app that served no
 *  requests and touched no KV is dormant, not news — it's dropped from the
 *  digest rather than padding it with a row of zeroes. Egress/CPU/memory are
 *  deliberately NOT consulted: they can't be non-zero without one of these. */
export function isActiveApp(a: AppUsage): boolean {
  return a.requests > 0 || a.kvReadUnits > 0 || a.kvWriteUnits > 0;
}

/** Busiest first, so the interesting apps head the list and the email. Ties
 *  break on KV reads then name, so the order is stable run to run. */
export function rankApps(apps: AppUsage[]): AppUsage[] {
  return [...apps].sort((a, b) =>
    b.requests - a.requests || b.kvReadUnits - a.kvReadUnits || a.app.localeCompare(b.app)
  );
}

/** Thousands separators, so a 6-figure KV count is readable at a glance.
 *  Rounded — an average is fractional and a table column of decimals doesn't
 *  help anyone eyeball a trend. */
function group(n: number): string {
  return Math.round(n).toLocaleString("en-US");
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
  const active = ranked.filter(isActiveApp);
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
    const costW = w((a) => formatUSD(a.costUSD, 3));
    for (const a of shown) {
      lines.push(
        `${a.app.padEnd(nameW)}  ${group(a.requests).padStart(reqW)} req  ` +
          `${group(a.kvReadUnits).padStart(readW)} KVr  ` +
          `${group(a.kvWriteUnits).padStart(writeW)} KVw  ` +
          `${formatUSD(a.costUSD, 3).padStart(costW)}` +
          (a.errored ? "  ⚠️ partial" : ""),
      );
    }
  }
  const more = active.length - shown.length;
  if (more > 0) lines.push(`+${more} more`);
  if (idle > 0) lines.push(`+${idle} idle`);
  return lines.join("\n") || "(no activity)";
}

// --- trailing 7-day trend ---------------------------------------------------

/** One day of the trailing series, in display units. */
export interface DayUsage {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** Short local label for a table row, e.g. `Sun 19/July`. */
  label: string;
  requests: number;
  kvReadUnits: number;
  kvWriteUnits: number;
  egressGB: number;
  cpuHours: number;
  memoryGBHours: number;
}

/** The metrics compared across days, and how they're labelled in the trend. */
export const TREND_COLUMNS = [
  { key: "requests", label: "Requests" },
  { key: "kvReadUnits", label: "KV reads" },
  { key: "kvWriteUnits", label: "KV writes" },
] as const;
export type TrendKey = typeof TREND_COLUMNS[number]["key"];

export function toDayUsage(date: string, label: string, t: Record<Metric, number>): DayUsage {
  return {
    date,
    label,
    requests: t.request_count,
    kvReadUnits: t.kv_read_units,
    kvWriteUnits: t.kv_write_units,
    egressGB: round(t.network_egress_bytes / 1e9, 3),
    cpuHours: round(t.cpu_seconds / 3600, 2),
    memoryGBHours: round(t.memory_time_byte_seconds / (1e9 * 3600), 1),
  };
}

/** Mean of a metric across the series (0 for an empty series). */
export function averageOf(series: DayUsage[], key: TrendKey): number {
  if (series.length === 0) return 0;
  return series.reduce((a, d) => a + d[key], 0) / series.length;
}

/**
 * Percent change from `previous` to `current`. Returns null when there is no
 * meaningful baseline (no previous day, or a previous value of 0 — "up from
 * nothing" is not a percentage), so the caller renders a dash instead of
 * Infinity or a fake 100%.
 */
export function pctChange(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/** A percent change as a signed arrow, e.g. `▲12%` / `▼8%` / `—`. */
export function formatDelta(pct: number | null): string {
  if (pct === null) return "—";
  const r = Math.round(pct);
  if (r === 0) return "0%";
  return `${r > 0 ? "▲" : "▼"}${Math.abs(r)}%`;
}

/** Yesterday against the day before, and against the trailing average. */
export interface TrendComparison {
  vsPrevDay: number | null;
  vsAverage: number | null;
}

export function compareLatest(series: DayUsage[], key: TrendKey): TrendComparison {
  if (series.length === 0) return { vsPrevDay: null, vsAverage: null };
  const latest = series[series.length - 1][key];
  const prev = series.length >= 2 ? series[series.length - 2][key] : null;
  // Average EXCLUDING the latest day — comparing a day against an average it is
  // itself part of would damp the very deviation we're trying to surface.
  const baseline = series.slice(0, -1);
  return {
    vsPrevDay: prev === null ? null : pctChange(latest, prev),
    vsAverage: baseline.length === 0 ? null : pctChange(latest, averageOf(baseline, key)),
  };
}

function padCols(rows: string[][], align: Array<"l" | "r">): string[] {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) =>
    r.map((cell, c) => (align[c] === "l" ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join("  ").trimEnd()
  );
}

/**
 * Render the trailing series as a fixed-width table: one row per day (oldest
 * first, so the most recent reads last next to the totals), then the period
 * total and average, then how the latest day compares to each.
 */
export function formatTrend(series: DayUsage[]): string {
  if (series.length === 0) return "(no history)";
  const header = ["Day", ...TREND_COLUMNS.map((c) => c.label)];
  const body = series.map((d) => [d.label, ...TREND_COLUMNS.map((c) => group(d[c.key]))]);
  const total = ["Total", ...TREND_COLUMNS.map((c) => group(series.reduce((a, d) => a + d[c.key], 0)))];
  const avg = ["Average", ...TREND_COLUMNS.map((c) => group(averageOf(series, c.key)))];

  const rows = padCols([header, ...body, total, avg], ["l", "r", "r", "r"]);
  const ruleWidth = Math.max(...rows.map((r) => r.length));
  const rule = "─".repeat(ruleWidth);
  const out = [
    rows[0],
    rule,
    ...rows.slice(1, 1 + body.length),
    rule,
    ...rows.slice(1 + body.length),
  ];

  if (series.length >= 2) {
    const latest = series[series.length - 1];
    const cmp = TREND_COLUMNS.map((c) => {
      const { vsPrevDay, vsAverage } = compareLatest(series, c.key);
      return `${c.label} ${formatDelta(vsPrevDay)} vs prior day, ${formatDelta(vsAverage)} vs avg`;
    });
    out.push("", `${latest.label} vs the rest of the period:`, ...cmp.map((l) => `  ${l}`));
  }
  return out.join("\n");
}

/** Assemble the whole digest email body: the reporting day's totals, its
 *  per-app breakdown, then the trailing trend. One `{report}` capture so the
 *  alert template doesn't have to reproduce this layout. */
export function buildReport(input: {
  windowLabel: string;
  requests: number;
  kvReadUnits: number;
  kvWriteUnits: number;
  egressGB: number;
  cpuHours: number;
  appsActive: number;
  apps: number;
  breakdown: string;
  cost?: UsageCost;
  /** Window length in hours, used to extrapolate the cost to a month. */
  hours?: number;
  trend?: string;
  trendDays?: number;
}): string {
  const stats = padCols([
    ["Requests", group(input.requests)],
    ["KV reads", group(input.kvReadUnits)],
    ["KV writes", group(input.kvWriteUnits)],
    ["Egress", `${input.egressGB} GB`],
    ["CPU", `${input.cpuHours} h`],
  ], ["l", "r"]);

  const out = [
    input.windowLabel,
    "",
    ...stats,
    "",
    `${input.appsActive} of ${input.apps} apps active`,
    "",
    "BY APP",
    input.breakdown,
  ];
  if (input.cost) {
    const rows = COST_LABELS
      .filter(([m]) => input.cost!.byMetric[m] > 0)
      .map(([m, label]) => [label, formatUSD(input.cost!.byMetric[m], 3)]);
    rows.push(["Total", formatUSD(input.cost.totalUSD, 2)]);
    out.push("", "COST (metered usage at list rate)", ...padCols(rows, ["l", "r"]));
    if (input.hours && input.hours > 0) {
      const monthly = input.cost.totalUSD * (730 / input.hours);
      out.push(`≈ ${formatUSD(monthly, 2)}/month at this rate`);
    }
    out.push(
      "Excludes the plan fee and any provisioned database/storage, and ignores",
      "monthly included allotments — for attribution, not billing.",
    );
  }
  if (input.trend) {
    out.push("", `TRAILING ${input.trendDays ?? ""} DAYS`.replace(/\s+/g, " ").trim(), input.trend);
  }
  return out.join("\n");
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
