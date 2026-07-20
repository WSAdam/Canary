import { assertAlmostEquals, assertEquals } from "jsr:@std/assert";
import {
  type AnalyticsResponse,
  estimateSpendUSD,
  averageOf,
  buildReport,
  compareLatest,
  type DayUsage,
  formatBreakdown,
  formatDelta,
  formatTrend,
  formatUSD,
  isActiveApp,
  listCost,
  mergeTotals,
  type Metric,
  type PlanCosts,
  pctChange,
  pctOfBudget,
  PRO_PLAN,
  rankApps,
  sumAnalytics,
  sumAnalyticsByDay,
  sumAnalyticsWhere,
  toAppUsage,
  toDayUsage,
} from "./deno-usage.ts";
import { dayKey } from "../time-window/time-window.ts";

// A response shaped exactly like the v2 API: fields describe columns, each row
// is positionally aligned to fields. Two 15-min buckets.
const res: AnalyticsResponse = {
  fields: [
    { name: "time", type: "time" },
    { name: "request_count", type: "number" },
    { name: "kv_read_units", type: "number" },
    { name: "kv_write_units", type: "number" },
    { name: "network_egress_bytes", type: "number" },
  ],
  values: [
    ["2026-07-01T00:00:00Z", 100, 40, 10, 1_000_000],
    ["2026-07-01T00:15:00Z", 50, 60, 5, 2_000_000],
  ],
};

Deno.test("sumAnalytics - sums each metric column by name across rows", () => {
  const t = sumAnalytics(res);
  assertEquals(t.request_count, 150);
  assertEquals(t.kv_read_units, 100);
  assertEquals(t.kv_write_units, 15);
  assertEquals(t.network_egress_bytes, 3_000_000);
  // A metric absent from `fields` stays 0, never NaN.
  assertEquals(t.cpu_seconds, 0);
  assertEquals(t.memory_time_byte_seconds, 0);
});

Deno.test("sumAnalytics - matches by name, not position (reordered/extra columns)", () => {
  const reordered: AnalyticsResponse = {
    fields: [
      { name: "kv_write_units", type: "number" },
      { name: "time", type: "time" },
      { name: "unknown_future_metric", type: "number" },
      { name: "request_count", type: "number" },
    ],
    values: [[7, "2026-07-01T00:00:00Z", 999, 12]],
  };
  const t = sumAnalytics(reordered);
  assertEquals(t.kv_write_units, 7);
  assertEquals(t.request_count, 12);
  assertEquals(t.kv_read_units, 0);
});

Deno.test("sumAnalytics - ignores non-numeric / null cells", () => {
  const dirty: AnalyticsResponse = {
    fields: [{ name: "time", type: "time" }, { name: "request_count", type: "number" }],
    // deno-lint-ignore no-explicit-any
    values: [["t", 5], ["t", null as any], ["t", "oops" as any], ["t", 5]],
  };
  assertEquals(sumAnalytics(dirty).request_count, 10);
});

Deno.test("mergeTotals - adds per-app totals into an org-wide total", () => {
  const a = sumAnalytics(res);
  const merged = mergeTotals([a, a, a]);
  assertEquals(merged.request_count, 450);
  assertEquals(merged.kv_read_units, 300);
});

Deno.test("estimateSpendUSD - unit conversions + overage math on a known fixture", () => {
  // A plan where every allotment is 0 so the whole conversion×price is billed.
  const plan: PlanCosts = {
    request_count: { allotment: 0, pricePerUnit: 2 / 1_000_000, toUnits: (r) => r },
    network_egress_bytes: { allotment: 0, pricePerUnit: 0.5, toUnits: (r) => r / 1e9 },
    cpu_seconds: { allotment: 0, pricePerUnit: 0.05, toUnits: (r) => r / 3600 },
    memory_time_byte_seconds: { allotment: 0, pricePerUnit: 0.016, toUnits: (r) => r / (1e9 * 3600) },
    kv_read_units: { allotment: 0, pricePerUnit: 1 / 1_000_000, toUnits: (r) => r },
    kv_write_units: { allotment: 0, pricePerUnit: 2.5 / 1_000_000, toUnits: (r) => r },
  };
  const totals = {
    request_count: 1_000_000, // → $2.00
    network_egress_bytes: 10e9, // 10 GB → $5.00
    cpu_seconds: 3600, // 1 CPU-h → $0.05
    memory_time_byte_seconds: 1e9 * 3600, // 1 GB-h → $0.016
    kv_read_units: 2_000_000, // → $2.00
    kv_write_units: 400_000, // → $1.00
  };
  // 2 + 5 + 0.05 + 0.016 + 2 + 1 = 10.066
  assertAlmostEquals(estimateSpendUSD(totals, plan), 10.066, 1e-9);
});

Deno.test("estimateSpendUSD - allotment is free; only the overage is billed; base is added", () => {
  const plan: PlanCosts = {
    ...PRO_PLAN,
    request_count: { allotment: 100, pricePerUnit: 1, toUnits: (r) => r },
  };
  const totals = { ...mergeTotals([]), request_count: 150 }; // 50 over × $1 = $50
  assertAlmostEquals(estimateSpendUSD(totals, plan, /*baseUSD*/ 20), 70, 1e-9);
  // Under allotment → only the base.
  assertAlmostEquals(estimateSpendUSD({ ...mergeTotals([]), request_count: 80 }, plan, 20), 20, 1e-9);
});

Deno.test("pctOfBudget - ratio, and a non-positive budget is 0 not Infinity/NaN", () => {
  assertAlmostEquals(pctOfBudget(80, 200), 40, 1e-9);
  assertEquals(pctOfBudget(50, 0), 0);
  assertEquals(pctOfBudget(50, -10), 0);
});

// --- per-app breakdown ------------------------------------------------------

function totals(over: Partial<Record<Metric, number>>): Record<Metric, number> {
  return {
    request_count: 0,
    network_egress_bytes: 0,
    cpu_seconds: 0,
    memory_time_byte_seconds: 0,
    kv_read_units: 0,
    kv_write_units: 0,
    ...over,
  };
}

Deno.test("toAppUsage - converts raw metrics to display units", () => {
  const u = toAppUsage("autobottom", totals({
    request_count: 1200,
    kv_read_units: 5400,
    kv_write_units: 900,
    network_egress_bytes: 2.5e9,
    cpu_seconds: 7200,
    memory_time_byte_seconds: 1e9 * 3600 * 3,
  }));
  assertEquals(u.app, "autobottom");
  assertEquals(u.requests, 1200);
  assertEquals(u.kvReadUnits, 5400);
  assertEquals(u.egressGB, 2.5);
  assertEquals(u.cpuHours, 2);
  assertEquals(u.memoryGBHours, 3);
  assertEquals(u.errored, undefined, "a clean app carries no errored flag");
});

Deno.test("toAppUsage - flags an app whose analytics call failed", () => {
  assertEquals(toAppUsage("sms-bot", totals({}), true).errored, true);
});

Deno.test("rankApps - busiest first, stable on ties", () => {
  const ranked = rankApps([
    toAppUsage("quiet", totals({ request_count: 5 })),
    toAppUsage("busy", totals({ request_count: 900 })),
    // Same requests as "tie-a" — broken by KV reads, then name.
    toAppUsage("tie-b", totals({ request_count: 100, kv_read_units: 10 })),
    toAppUsage("tie-a", totals({ request_count: 100, kv_read_units: 99 })),
  ]);
  assertEquals(ranked.map((a) => a.app), ["busy", "tie-a", "tie-b", "quiet"]);
});

Deno.test("rankApps - does not mutate its input", () => {
  const input = [toAppUsage("a", totals({ request_count: 1 })), toAppUsage("b", totals({ request_count: 2 }))];
  rankApps(input);
  assertEquals(input.map((a) => a.app), ["a", "b"]);
});

Deno.test("formatBreakdown - aligned columns, grouped digits, busiest first", () => {
  const out = formatBreakdown([
    toAppUsage("sms-bot", totals({ request_count: 42, kv_read_units: 7, kv_write_units: 1 })),
    toAppUsage("autobottom", totals({ request_count: 12345, kv_read_units: 54201, kv_write_units: 8102 })),
  ]);
  const lines = out.split("\n");
  assertEquals(lines.length, 2);
  assertEquals(lines[0].startsWith("autobottom"), true, "busiest app leads");
  assertEquals(lines[0].includes("12,345 req"), true, "thousands are grouped");
  // Both rows' "req" markers must land in the same column.
  assertEquals(lines[0].indexOf(" req"), lines[1].indexOf(" req"));
});

Deno.test("formatBreakdown - collapses idle apps into a count", () => {
  const out = formatBreakdown([
    toAppUsage("live", totals({ request_count: 10 })),
    toAppUsage("idle-1", totals({})),
    toAppUsage("idle-2", totals({})),
  ]);
  assertEquals(out.includes("+2 idle"), true);
  assertEquals(out.includes("idle-1"), false, "idle apps are not listed individually");
});

Deno.test("formatBreakdown - an app with only KV traffic still counts as active", () => {
  const out = formatBreakdown([toAppUsage("kv-only", totals({ kv_read_units: 5 }))]);
  assertEquals(out.includes("kv-only"), true);
  assertEquals(out.includes("idle"), false);
});

Deno.test("formatBreakdown - caps the listed rows and reports the remainder", () => {
  const many = Array.from({ length: 20 }, (_, i) => toAppUsage(`app-${i}`, totals({ request_count: 100 - i })));
  const out = formatBreakdown(many, 5);
  assertEquals(out.split("\n").length, 6, "5 rows + the '+N more' line");
  assertEquals(out.includes("+15 more"), true);
});

Deno.test("formatBreakdown - marks a partial app and handles an empty org", () => {
  assertEquals(formatBreakdown([toAppUsage("broken", totals({ request_count: 3 }), true)]).includes("⚠️ partial"), true);
  assertEquals(formatBreakdown([]), "(no activity)");
});

Deno.test("isActiveApp - any one dimension of traffic counts as active", () => {
  assertEquals(isActiveApp(toAppUsage("req-only", totals({ request_count: 1 }))), true);
  assertEquals(isActiveApp(toAppUsage("read-only", totals({ kv_read_units: 1 }))), true);
  assertEquals(isActiveApp(toAppUsage("write-only", totals({ kv_write_units: 1 }))), true);
});

Deno.test("isActiveApp - an all-zero app is idle and gets filtered out", () => {
  assertEquals(isActiveApp(toAppUsage("alfred-e2e-upstream", totals({}))), false);
});

// --- trailing trend ---------------------------------------------------------

// Three 15-min buckets spanning two ET days: 19 July 20:00 EDT (= 20th 00:00Z)
// is still the 19th locally, which is exactly the trap day-bucketing must avoid.
const spanning: AnalyticsResponse = {
  fields: [
    { name: "time", type: "time" },
    { name: "request_count", type: "number" },
    { name: "kv_read_units", type: "number" },
  ],
  values: [
    ["2026-07-19T12:00:00Z", 10, 1], // 08:00 EDT 19th
    ["2026-07-20T00:00:00Z", 20, 2], // 20:00 EDT 19th — still the 19th locally
    ["2026-07-20T16:00:00Z", 40, 4], // 12:00 EDT 20th
  ],
};

const etDayKey = (t: number) => dayKey(new Date(t));

Deno.test("sumAnalyticsWhere - sums only the buckets inside the window", () => {
  const t = sumAnalyticsWhere(
    spanning,
    (ms) => ms >= Date.parse("2026-07-20T00:00:00Z") && ms <= Date.parse("2026-07-20T23:59:59Z"),
  );
  assertEquals(t.request_count, 60); // the 2nd and 3rd buckets
});

Deno.test("sumAnalyticsWhere - a response with no time column sums everything", () => {
  const noTime: AnalyticsResponse = {
    fields: [{ name: "request_count", type: "number" }],
    values: [[5], [7]],
  };
  assertEquals(sumAnalyticsWhere(noTime, () => false).request_count, 12);
});

Deno.test("sumAnalyticsByDay - buckets by LOCAL day, not UTC day", () => {
  const byDay = sumAnalyticsByDay(spanning, etDayKey);
  assertEquals(Object.keys(byDay).sort(), ["2026-07-19", "2026-07-20"]);
  // The 20:00 EDT bucket (00:00Z on the 20th) must land on the 19th.
  assertEquals(byDay["2026-07-19"].request_count, 30);
  assertEquals(byDay["2026-07-20"].request_count, 40);
});

Deno.test("sumAnalyticsByDay - no time column yields no days", () => {
  const noTime: AnalyticsResponse = { fields: [{ name: "request_count", type: "number" }], values: [[5]] };
  assertEquals(Object.keys(sumAnalyticsByDay(noTime, etDayKey)).length, 0);
});

function day(date: string, label: string, requests: number, reads = 0, writes = 0): DayUsage {
  return toDayUsage(date, label, totals({
    request_count: requests,
    kv_read_units: reads,
    kv_write_units: writes,
  }));
}

Deno.test("pctChange - percent difference, null when there's no baseline", () => {
  assertEquals(pctChange(110, 100), 10);
  assertEquals(pctChange(50, 100), -50);
  // Growth from zero isn't a percentage — must not be Infinity.
  assertEquals(pctChange(5, 0), null);
});

Deno.test("formatDelta - signed arrows, dash when unknown", () => {
  assertEquals(formatDelta(12.4), "▲12%");
  assertEquals(formatDelta(-8.2), "▼8%");
  assertEquals(formatDelta(0.2), "0%");
  assertEquals(formatDelta(null), "—");
});

Deno.test("averageOf - mean across the series, 0 when empty", () => {
  assertEquals(averageOf([day("a", "A", 10), day("b", "B", 20)], "requests"), 15);
  assertEquals(averageOf([], "requests"), 0);
});

Deno.test("compareLatest - latest vs prior day and vs the PRECEDING average", () => {
  const series = [day("1", "Mon", 100), day("2", "Tue", 100), day("3", "Wed", 150)];
  const c = compareLatest(series, "requests");
  assertEquals(c.vsPrevDay, 50); // 150 vs 100
  // Baseline excludes the latest day: avg(100,100) = 100 → +50%, NOT avg of all
  // three (116.7 → +28%), which would damp the deviation being surfaced.
  assertEquals(c.vsAverage, 50);
});

Deno.test("compareLatest - single-day and empty series have no baseline", () => {
  assertEquals(compareLatest([day("1", "Mon", 10)], "requests"), { vsPrevDay: null, vsAverage: null });
  assertEquals(compareLatest([], "requests"), { vsPrevDay: null, vsAverage: null });
});

Deno.test("formatTrend - a row per day, then totals, average and the comparison", () => {
  const out = formatTrend([
    day("2026-07-18", "Sat 18/July", 15102, 98004, 12880),
    day("2026-07-19", "Sun 19/July", 17759, 122395, 14019),
  ]);
  const lines = out.split("\n");
  assertEquals(lines[0].includes("Requests"), true, "has a header");
  assertEquals(out.includes("15,102"), true);
  assertEquals(out.includes("17,759"), true);
  assertEquals(out.includes("Total"), true);
  assertEquals(out.includes("Average"), true);
  // 17,759 vs 15,102 is +17.6% → ▲18%.
  assertEquals(out.includes("▲18% vs prior day"), true, out);
  // Oldest first, so the latest day sits next to the totals.
  assertEquals(out.indexOf("15,102") < out.indexOf("17,759"), true);
});

Deno.test("formatTrend - a single day renders without a comparison block", () => {
  const out = formatTrend([day("2026-07-19", "Sun 19/July", 100)]);
  assertEquals(out.includes("vs prior day"), false);
  assertEquals(out.includes("100"), true);
});

Deno.test("formatTrend - an empty series says so rather than rendering an empty table", () => {
  assertEquals(formatTrend([]), "(no history)");
});

Deno.test("buildReport - assembles window, stats, per-app and trend in order", () => {
  const report = buildReport({
    windowLabel: "19/July/2026 00:00 → 23:59 EDT",
    requests: 17759,
    kvReadUnits: 122395,
    kvWriteUnits: 14019,
    egressGB: 0.145,
    cpuHours: 1.44,
    appsActive: 8,
    apps: 23,
    breakdown: "cockpit  4,038 req",
    trend: "TREND TABLE",
    trendDays: 7,
  });
  assertEquals(report.includes("19/July/2026 00:00 → 23:59 EDT"), true);
  assertEquals(report.includes("17,759"), true);
  assertEquals(report.includes("8 of 23 apps active"), true);
  assertEquals(report.includes("BY APP"), true);
  assertEquals(report.includes("TRAILING 7 DAYS"), true);
  // Order: window → stats → by app → trend.
  assertEquals(report.indexOf("BY APP") < report.indexOf("TRAILING 7 DAYS"), true);
});

Deno.test("buildReport - omits the trend section entirely when there is none", () => {
  const report = buildReport({
    windowLabel: "w",
    requests: 1,
    kvReadUnits: 0,
    kvWriteUnits: 0,
    egressGB: 0,
    cpuHours: 0,
    appsActive: 1,
    apps: 1,
    breakdown: "b",
  });
  assertEquals(report.includes("TRAILING"), false);
});

// --- cost attribution -------------------------------------------------------

Deno.test("listCost - prices each dimension at list rate and sums them", () => {
  const c = listCost(totals({
    request_count: 1_000_000, // $2.00
    kv_read_units: 1_000_000, // $1.00
    kv_write_units: 1_000_000, // $2.50
    network_egress_bytes: 10e9, // 10 GB → $5.00
    cpu_seconds: 3600, // 1 CPU-h → $0.05
    memory_time_byte_seconds: 1e9 * 3600, // 1 GB-h → $0.016
  }));
  assertAlmostEquals(c.byMetric.request_count, 2, 1e-9);
  assertAlmostEquals(c.byMetric.kv_read_units, 1, 1e-9);
  assertAlmostEquals(c.byMetric.kv_write_units, 2.5, 1e-9);
  assertAlmostEquals(c.byMetric.network_egress_bytes, 5, 1e-9);
  assertAlmostEquals(c.totalUSD, 10.566, 1e-9);
});

Deno.test("listCost - IGNORES allotments (they're org-wide and monthly)", () => {
  // PRO_PLAN includes 5M requests. Under an allotment-aware model this would be
  // $0; per app-day the allowance is unattributable, so list rate is charged.
  const c = listCost(totals({ request_count: 1_000_000 }));
  assertAlmostEquals(c.totalUSD, 2, 1e-9);
  // estimateSpendUSD is the allotment-aware one, and must still say $0 here.
  assertEquals(estimateSpendUSD(totals({ request_count: 1_000_000 })), 0);
});

Deno.test("listCost - zero usage costs nothing", () => {
  assertEquals(listCost(totals({})).totalUSD, 0);
});

Deno.test("formatUSD - fixed precision, widened where fractions of a cent matter", () => {
  assertEquals(formatUSD(0.1188, 3), "$0.119");
  assertEquals(formatUSD(12.5), "$12.50");
});

Deno.test("toAppUsage - carries the app's list-rate cost", () => {
  // 1M KV reads at $1/M.
  assertAlmostEquals(toAppUsage("cockpit", totals({ kv_read_units: 1_000_000 })).costUSD, 1, 1e-9);
});

Deno.test("formatBreakdown - includes a right-aligned cost column", () => {
  const out = formatBreakdown([
    toAppUsage("cockpit", totals({ request_count: 4038, kv_read_units: 118818, kv_write_units: 10835 })),
    toAppUsage("argus", totals({ request_count: 14 })),
  ]);
  const lines = out.split("\n");
  assertEquals(lines[0].includes("$"), true, `no cost column: ${lines[0]}`);
  // The $ signs line up across rows.
  assertEquals(lines[0].indexOf("$"), lines[1].indexOf("$"));
});

Deno.test("buildReport - cost section lists only non-zero dimensions, with the caveat", () => {
  const report = buildReport({
    windowLabel: "w",
    requests: 100,
    kvReadUnits: 0,
    kvWriteUnits: 0,
    egressGB: 0,
    cpuHours: 0,
    appsActive: 1,
    apps: 1,
    breakdown: "b",
    cost: listCost(totals({ request_count: 1_000_000 })),
    hours: 24,
  });
  assertEquals(report.includes("COST (metered usage at list rate)"), true);
  // Scope to the cost section: the stats block above it names every dimension
  // regardless, so a whole-report search would always find "KV reads".
  const costSection = report.slice(report.indexOf("COST (metered usage at list rate)"));
  assertEquals(costSection.includes("Requests"), true);
  // Dimensions costing nothing are omitted rather than padding with $0.000.
  assertEquals(costSection.includes("KV reads"), false);
  // $2/day over 730h/month ≈ $60.83.
  assertEquals(report.includes("$60.83/month"), true, report);
  assertEquals(report.includes("not billing"), true, "must not read as an invoice");
});

Deno.test("buildReport - omits the cost section entirely when no cost is given", () => {
  const report = buildReport({
    windowLabel: "w",
    requests: 1,
    kvReadUnits: 0,
    kvWriteUnits: 0,
    egressGB: 0,
    cpuHours: 0,
    appsActive: 1,
    apps: 1,
    breakdown: "b",
  });
  assertEquals(report.includes("COST"), false);
});
