import { assertEquals } from "jsr:@std/assert";
import { applyVars, BaseAlertChannel, buildVars } from "./mod.ts";
import type { RunResultDto } from "../../../dto/run-result-dto.ts";

Deno.test("BaseAlertChannel exists", () => {
  assertEquals(typeof BaseAlertChannel, "function");
});

Deno.test("applyVars - substitutes known tokens", () => {
  assertEquals(applyVars("hi {monitor}: {status}", { monitor: "api", status: "FAILED" }), "hi api: FAILED");
});

Deno.test("applyVars - leaves unknown tokens untouched", () => {
  assertEquals(applyVars("{a} {b}", { a: "1" }), "1 {b}");
});

Deno.test("applyVars - inserts $ values literally (no String.replace special patterns)", () => {
  // Regression for the $-corruption bug: a captured value like "$5" / "$&" must
  // be inserted verbatim, not interpreted as a replacement pattern.
  assertEquals(applyVars("price is {p}", { p: "$5" }), "price is $5");
  assertEquals(applyVars("x {p}", { p: "$&$1$$" }), "x $&$1$$");
});

Deno.test("buildVars - exposes error and status for a failed run", () => {
  const run: RunResultDto = {
    runId: "r1",
    monitorId: "m1",
    monitorName: "API",
    observed: 0,
    passed: false,
    timestamp: "2026-06-02T00:00:00.000Z",
    error: "HTTP 500 from https://api",
  };
  const vars = buildVars(run);
  assertEquals(vars.status, "FAILED");
  assertEquals(vars.monitor, "API");
  assertEquals(vars.error, "HTTP 500 from https://api");
  assertEquals(vars.observed, "0");
});

Deno.test("buildVars - error empty when absent; captures merged; falls back to id", () => {
  const run: RunResultDto = {
    runId: "r2",
    monitorId: "m2",
    observed: 7,
    passed: true,
    timestamp: "2026-06-02T00:00:00.000Z",
    captures: { city: "NYC" },
  };
  const vars = buildVars(run);
  assertEquals(vars.status, "RECOVERED");
  assertEquals(vars.error, "");
  assertEquals(vars.city, "NYC");
  assertEquals(vars.monitor, "m2");
});
