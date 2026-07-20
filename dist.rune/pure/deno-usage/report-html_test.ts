import { assertEquals } from "jsr:@std/assert";
import { buildHtmlReport, type HtmlReportInput } from "./report-html.ts";
import { buildPerAppSeries, listCost, type Metric, toAppUsage, toDayUsage } from "./deno-usage.ts";
import { byteLen } from "../../integration/runner-execute/runner-execute.ts";

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

/** A full-size fixture: 10 active apps, 7 days — the realistic worst case. */
function fixture(): HtmlReportInput {
  const byApp = Array.from({ length: 10 }, (_, i) =>
    toAppUsage(`app-${i}`, totals({
      request_count: 10_000 - i * 900,
      kv_read_units: i === 1 ? 118_818 : 0,
      kv_write_units: i === 1 ? 10_835 : 0,
    })));
  const days = Array.from({ length: 7 }, (_, d) => `2026-07-${13 + d}`);
  const series = days.map((k, d) =>
    toDayUsage(k, `Mon ${13 + d}/July`, totals({
      request_count: 90_000 - d * 10_000,
      kv_read_units: 3_000_000 - d * 400_000,
      kv_write_units: 55_000 - d * 5_000,
    })));
  const appDay: Record<string, Record<string, Record<Metric, number>>> = {};
  for (let i = 0; i < 10; i++) {
    appDay[`app-${i}`] = Object.fromEntries(days.map((k, d) => [
      k,
      totals({ request_count: 9_000 - i * 800 + d * 13, kv_read_units: i === 1 ? 400_000 - d * 40_000 : 0 }),
    ]));
  }
  const org = totals({ request_count: 16_019, kv_read_units: 122_263, kv_write_units: 14_173 });
  return {
    windowLabel: "19/July/2026 00:00 → 23:59 EDT",
    requests: 16_019,
    kvReadUnits: 122_263,
    kvWriteUnits: 14_173,
    egressGB: 0.129,
    cpuHours: 1.43,
    apps: 23,
    appsActive: 10,
    byApp,
    cost: listCost(org),
    projectedMonthlyUSD: 13.36,
    series,
    perApp: buildPerAppSeries(appDay, days),
  };
}

Deno.test("buildHtmlReport - contains every section incl. the per-app matrices", () => {
  const html = buildHtmlReport(fixture());
  for (const marker of [
    "daily usage",
    "19/July/2026 00:00 → 23:59 EDT",
    "BY APP",
    "COST",
    "TRAILING 7 DAYS",
    "REQUESTS BY APP", // the by-app 7-day breakdown
    "COST BY APP",
    "$13.36/month",
    "attribution, not billing",
  ]) {
    assertEquals(html.includes(marker), true, `missing: ${marker}`);
  }
});

Deno.test("buildHtmlReport - fits the capture byte budget with room for the text report", () => {
  const bytes = byteLen(buildHtmlReport(fixture()));
  // All captures share a 16KB budget; the text report takes ~2KB. Keep the
  // HTML under 13KB so BOTH always fit and the runner never silently drops one.
  assertEquals(bytes < 13_000, true, `reportHtml is ${bytes}B — over the 13KB budget`);
});

Deno.test("buildHtmlReport - escapes an app name that carries markup", () => {
  const input = fixture();
  input.byApp = [toAppUsage('<img src=x onerror=alert(1)>', totals({ request_count: 5 }))];
  const html = buildHtmlReport(input);
  assertEquals(html.includes("<img"), false, "unescaped app name");
  assertEquals(html.includes("&lt;img"), true);
});

Deno.test("buildHtmlReport - carries no comparison line (removed as noise)", () => {
  const html = buildHtmlReport(fixture());
  assertEquals(html.includes("vs the rest"), false);
  assertEquals(html.includes("Infinity") || html.includes("NaN"), false);
});

Deno.test("buildHtmlReport - matrix caps rows and reports the remainder", () => {
  const input = fixture();
  const extra = Object.fromEntries(
    Array.from({ length: 14 }, (_, i) => [`x-${i}`, { "2026-07-13": totals({ request_count: 1 + i }) }]),
  );
  input.perApp = buildPerAppSeries({ ...extra }, ["2026-07-13"]);
  input.series = input.series!.slice(0, 1);
  const html = buildHtmlReport(input);
  assertEquals(html.includes("+6 more"), true, "14 rows − 8 shown = +6 more");
});

Deno.test("buildHtmlReport - no trend sections without a series", () => {
  const input = fixture();
  delete input.series;
  delete input.perApp;
  const html = buildHtmlReport(input);
  assertEquals(html.includes("TRAILING"), false);
  assertEquals(html.includes("REQUESTS BY APP"), false);
});
