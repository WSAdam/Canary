import { assertEquals, assertMatch } from "jsr:@std/assert";
import { RunResult } from "./runResult.ts";
import { kv } from "../_kv.ts";
import type { RunResultDto } from "../../dto/run-result-dto.ts";

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

Deno.test("RunResult.getLatest - returns the newest run for a monitor", async () => {
  const monitorId = `getlatest-happy-${crypto.randomUUID()}`;
  const older: RunResultDto = {
    runId: crypto.randomUUID(), monitorId, observed: 1, passed: true,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
  const newer: RunResultDto = {
    runId: crypto.randomUUID(), monitorId, observed: 2, passed: false,
    timestamp: "2026-01-02T00:00:00.000Z",
  };
  await new RunResult().save(older);
  await new RunResult().save(newer);
  try {
    const latest = await RunResult.getLatest(monitorId);
    assertEquals(latest?.runId, newer.runId);
    assertEquals(latest?.observed, 2);
  } finally {
    await kv.delete(["run", monitorId, older.timestamp, older.runId]);
    await kv.delete(["run_idx", monitorId, older.timestamp, older.runId]);
    await kv.delete(["run", monitorId, newer.timestamp, newer.runId]);
    await kv.delete(["run_idx", monitorId, newer.timestamp, newer.runId]);
  }
});

Deno.test("RunResult.getLatest - returns null for a monitor with no runs", async () => {
  const latest = await RunResult.getLatest(`getlatest-empty-${crypto.randomUUID()}`);
  assertEquals(latest, null);
});

Deno.test("RunResult.getLatest - tolerates an undeserializable newest row (returns null, never throws)", async () => {
  // Simulate the production wedge: the newest run row's value won't deserialize,
  // so kv.list throws while reading it. getLatest must swallow that and report
  // "no previous run" instead of propagating — otherwise one bad row stops the
  // monitor from ever persisting or alerting again.
  const realList = kv.list.bind(kv);
  (kv as { list: unknown }).list = () => ({
    // deno-lint-ignore require-await
    async next() {
      throw new RangeError("invalid serialized data");
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  });
  try {
    const latest = await RunResult.getLatest("any-monitor");
    assertEquals(latest, null);
  } finally {
    (kv as { list: unknown }).list = realList;
  }
});
