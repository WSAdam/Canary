import { assertAlmostEquals, assertEquals } from "jsr:@std/assert";
import {
  type AnalyticsResponse,
  estimateSpendUSD,
  formatBreakdown,
  isActiveApp,
  mergeTotals,
  type Metric,
  type PlanCosts,
  pctOfBudget,
  PRO_PLAN,
  rankApps,
  sumAnalytics,
  toAppUsage,
} from "./deno-usage.ts";

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
