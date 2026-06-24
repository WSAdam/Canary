import { assert, assertEquals } from "jsr:@std/assert";
import { clampRunRowToKvLimit } from "./persistRunAndAlert.ts";
import type { RunResultDto } from "../../dto/run-result-dto.ts";

// Deno KV rejects a single value over ~64KiB; an over-limit row would throw on
// save and be silently dropped. clampRunRowToKvLimit is the shared chokepoint
// that guarantees the row fits regardless of which path (cron / webhook) built
// it — these guard against a caller-supplied oversized error/captures slipping
// through (the webhook-fire path had no caps of its own).

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const base: RunResultDto = {
  runId: "r",
  monitorId: "m",
  observed: 0,
  passed: true,
  timestamp: "2026-01-01T00:00:00.000Z",
};

Deno.test("clampRunRowToKvLimit leaves a small row unchanged", () => {
  const dto: RunResultDto = { ...base, captures: { a: "x" } };
  assertEquals(clampRunRowToKvLimit(dto), dto);
});

Deno.test("clampRunRowToKvLimit drops oversized captures to fit KV", () => {
  const dto: RunResultDto = { ...base, captures: { big: "X".repeat(80 * 1024) } };
  const out = clampRunRowToKvLimit(dto);
  assert(bytes(out) <= 56 * 1024, `still over limit: ${bytes(out)} bytes`);
  assertEquals(out.captures, undefined);
});

Deno.test("clampRunRowToKvLimit truncates an oversized error (webhook path)", () => {
  const dto: RunResultDto = { ...base, passed: false, error: "X".repeat(200 * 1024) };
  const out = clampRunRowToKvLimit(dto);
  assert(bytes(out) <= 56 * 1024, `still over limit: ${bytes(out)} bytes`);
  assert(out.error !== undefined && out.error.length < 200 * 1024);
});

Deno.test("clampRunRowToKvLimit fits oversized MULTI-BYTE content (byte, not code-unit)", () => {
  const dto: RunResultDto = { ...base, passed: false, error: "中".repeat(60 * 1024) }; // ~180KB UTF-8
  const out = clampRunRowToKvLimit(dto);
  assert(bytes(out) <= 56 * 1024, `still over limit: ${bytes(out)} bytes`);
});
