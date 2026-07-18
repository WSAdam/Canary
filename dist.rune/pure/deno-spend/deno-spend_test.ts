import { assertAlmostEquals, assertEquals, assertThrows } from "jsr:@std/assert";
import { parseCurrentUsageCost, parseSpendLimits, pctOfLimit } from "./deno-spend.ts";

// Synthetic payload with the EXACT real shape from console.deno.com (unquoted
// keys, quoted descriptions — not strict JSON), with placeholder numbers so no
// real billing figures land in the repo.
const SAMPLE_USAGE =
  '{total:120.5,items:[{description:"KV Reads (units)",total:40.25},{description:"CPU Time (s)",total:0.5},{description:"KV Writes (units)",total:30},{description:"Outbound Traffic (GB)",total:49.75}]}';

Deno.test("parseCurrentUsageCost - grand total is the first total, items itemized", () => {
  const s = parseCurrentUsageCost(SAMPLE_USAGE);
  assertAlmostEquals(s.totalUSD, 120.5, 1e-9);
  assertEquals(s.items.length, 4);
  assertEquals(s.items[0].description, "KV Reads (units)");
  assertAlmostEquals(s.items[0].costUSD, 40.25, 1e-9);
  assertEquals(s.items[3].description, "Outbound Traffic (GB)");
  assertAlmostEquals(s.items[3].costUSD, 49.75, 1e-9);
  // Items sum ≈ grand total (sanity).
  assertAlmostEquals(s.items.reduce((a, i) => a + i.costUSD, 0), s.totalUSD, 1e-6);
});

Deno.test("parseCurrentUsageCost - zero-spend payload", () => {
  const s = parseCurrentUsageCost("{total:0,items:[]}");
  assertEquals(s.totalUSD, 0);
  assertEquals(s.items.length, 0);
});

Deno.test("parseCurrentUsageCost - throws (fail loud) if the shape changes", () => {
  assertThrows(() => parseCurrentUsageCost('{"grandTotal":5}'));
});

Deno.test("parseSpendLimits - max is the hard cap; the rest are thresholds", () => {
  const { limitUSD, thresholds } = parseSpendLimits("[140,180,400]");
  assertEquals(limitUSD, 400);
  assertEquals(thresholds, [140, 180]);
});

Deno.test("parseSpendLimits - single-value (limit only, no thresholds)", () => {
  assertEquals(parseSpendLimits("[600]"), { limitUSD: 600, thresholds: [] });
});

Deno.test("parseSpendLimits - rejects a malformed payload", () => {
  assertThrows(() => parseSpendLimits('{"limit":400}'));
});

Deno.test("pctOfLimit - percentage of the hard limit, and guards a zero limit", () => {
  assertAlmostEquals(pctOfLimit(300, 400), 75, 1e-4);
  assertEquals(pctOfLimit(300, 0), 0);
});
