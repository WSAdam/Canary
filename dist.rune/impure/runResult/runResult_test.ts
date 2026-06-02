import { assertEquals, assertMatch } from "jsr:@std/assert";
import { RunResult } from "./runResult.ts";

Deno.test("RunResult.build - populates dto fields", () => {
  const dto = RunResult.build("mon-1", 42, true, "My Monitor").toDto();
  assertEquals(dto.monitorId, "mon-1");
  assertEquals(dto.observed, 42);
  assertEquals(dto.passed, true);
  assertEquals(dto.monitorName, "My Monitor");
  assertMatch(dto.runId, /^[0-9a-f-]{36}$/);
  assertMatch(dto.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

Deno.test("RunResult.build - carries error and captures for a failed run", () => {
  const dto = RunResult.build("mon-2", 0, false, undefined, "HTTP 500", { city: "NYC" }).toDto();
  assertEquals(dto.passed, false);
  assertEquals(dto.error, "HTTP 500");
  assertEquals(dto.captures, { city: "NYC" });
});

Deno.test("RunResult.build - each run gets a distinct runId", () => {
  const a = RunResult.build("mon-3", 1, true).toDto();
  const b = RunResult.build("mon-3", 1, true).toDto();
  assertEquals(a.runId === b.runId, false);
});
