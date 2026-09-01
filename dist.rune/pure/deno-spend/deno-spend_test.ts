import { assertAlmostEquals, assertEquals, assertThrows } from "jsr:@std/assert";
import { parseCurrentUsageCost, parseSpendLimits, pctOfLimit } from "./deno-spend.ts";

// Synthetic payloads with the EXACT shapes seen from console.deno.com, with
// placeholder numbers so no real billing figures land in the repo.

// Legacy (pre-2026-08): unquoted keys, quoted descriptions — not strict JSON.
const LEGACY =
  '{total:120.5,items:[{description:"KV Reads (units)",total:40.25},{description:"CPU Time (s)",total:0.5},{description:"KV Writes (units)",total:30},{description:"Outbound Traffic (GB)",total:49.75}]}';

// Strict-JSON variant (quoted keys) — the 2026-08 shape change direction.
const QUOTED =
  '{"total":120.5,"items":[{"description":"KV Reads (units)","total":40.25},{"description":"Outbound Traffic (GB)","total":80.25}]}';

Deno.test("parseCurrentUsageCost - legacy unquoted shape still parses", () => {
  const s = parseCurrentUsageCost(LEGACY);
  assertAlmostEquals(s.totalUSD, 120.5, 1e-9);
  assertEquals(s.items.length, 4);
  assertEquals(s.items[0].description, "KV Reads (units)");
  assertAlmostEquals(s.items.reduce((a, i) => a + i.costUSD, 0), s.totalUSD, 1e-6);
});

Deno.test("parseCurrentUsageCost - strict-JSON (quoted keys) shape parses", () => {
  const s = parseCurrentUsageCost(QUOTED);
  assertAlmostEquals(s.totalUSD, 120.5, 1e-9);
  assertEquals(s.items.length, 2);
  assertEquals(s.items[1].description, "Outbound Traffic (GB)");
  assertAlmostEquals(s.items[1].costUSD, 80.25, 1e-9);
});

Deno.test("parseCurrentUsageCost - JSON with renamed item keys still itemizes", () => {
  const s = parseCurrentUsageCost('{"total":5,"items":[{"name":"KV Reads","cost":5}]}');
  assertEquals(s.items, [{ description: "KV Reads", costUSD: 5 }]);
});

Deno.test("parseCurrentUsageCost - 'subtotal' can NOT be misread as the total", () => {
  // The 2026-08 incident: an unanchored /total:/ matched inside `subtotal: 0`
  // and the guardrail silently reported $0 (pct=0 → passing). A field that
  // merely contains "total" must never satisfy the parse.
  const err = assertThrows(() => parseCurrentUsageCost("{subtotal: 0, usageTotal: 99}")) as Error;
  assertEquals(err.message.includes("shape changed"), true);
});

Deno.test("parseCurrentUsageCost - a billing-cycle-reset zero is a REAL number", () => {
  // Verbatim live payload from 2026-08-31 8PM — renewal day: the fresh cycle
  // genuinely holds $0 with an explicit empty items array. The zero-guard's
  // first form threw on this and paged hourly on a true zero.
  const s = parseCurrentUsageCost("{total:0,items:[],usage:[]}");
  assertEquals(s.totalUSD, 0);
  assertEquals(s.items, []);
  // Same for a strict-JSON equivalent.
  assertEquals(parseCurrentUsageCost('{"total":0,"items":[]}').totalUSD, 0);
});

Deno.test("parseCurrentUsageCost - $0 WITHOUT any items structure still fails loud", () => {
  // A misread shape pins the guardrail at 0% forever if this returns. The
  // guard trusts a zero only when a recognized items array is present —
  // a bare total with no items structure remains a shape-change signature.
  assertThrows(() => parseCurrentUsageCost("{total:0}"));
  assertThrows(() => parseCurrentUsageCost('{"total":0}'));
  assertThrows(() => parseCurrentUsageCost("{total:0,lineItemsV2:{}}"));
});

Deno.test("parseCurrentUsageCost - a genuine zero WITH items is accepted", () => {
  const s = parseCurrentUsageCost('{"total":0,"items":[{"description":"KV Reads (units)","total":0}]}');
  assertEquals(s.totalUSD, 0);
});

Deno.test("parseCurrentUsageCost - parse errors carry a payload snippet", () => {
  const err = assertThrows(() => parseCurrentUsageCost('{"grandTotalCents":5}')) as Error;
  assertEquals(err.message.includes("grandTotalCents"), true, "error must show what arrived: " + err.message);
});

Deno.test("parseSpendLimits - max is the hard cap; the rest are thresholds", () => {
  const { limitUSD, thresholds } = parseSpendLimits("[140,180,400]");
  assertEquals(limitUSD, 400);
  assertEquals(thresholds, [140, 180]);
});

Deno.test("parseSpendLimits - single-value (limit only, no thresholds)", () => {
  assertEquals(parseSpendLimits("[600]"), { limitUSD: 600, thresholds: [] });
});

Deno.test("parseSpendLimits - rejects a malformed payload, naming what arrived", () => {
  const err = assertThrows(() => parseSpendLimits('{"limit":400}')) as Error;
  assertEquals(err.message.includes("limit"), true);
  assertThrows(() => parseSpendLimits("not json at all"));
});

Deno.test("pctOfLimit - percentage of the hard limit, and guards a zero limit", () => {
  assertAlmostEquals(pctOfLimit(300, 400), 75, 1e-4);
  assertEquals(pctOfLimit(300, 0), 0);
});

Deno.test("parseCurrentUsageCost - the live 2026-08-06 shape: no leading zero on sub-1 numbers", () => {
  // Verbatim shape from the failing run's payload snippet (placeholder value):
  // numbers below 1 arrive as `.159962`, not `0.159962`.
  const s = parseCurrentUsageCost('{total:.25,items:[{description:"KV Reads (units)",total:.25}]}');
  assertAlmostEquals(s.totalUSD, 0.25, 1e-9);
  assertEquals(s.items, [{ description: "KV Reads (units)", costUSD: 0.25 }]);
});

Deno.test("parseCurrentUsageCost - negative bare-decimal (a credit) parses too", () => {
  const s = parseCurrentUsageCost('{total:.5,items:[{description:"Credit",total:-.25},{description:"KV Reads (units)",total:.75}]}');
  assertAlmostEquals(s.items[0].costUSD, -0.25, 1e-9);
});
