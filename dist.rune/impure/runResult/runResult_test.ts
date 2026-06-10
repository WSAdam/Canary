import { assertEquals, assertExists, assertMatch, assertRejects, assertStringIncludes } from "jsr:@std/assert";
import { RunResult } from "./runResult.ts";
import { kv } from "../_kv.ts";
import { log } from "../_log.ts";
import type { RunResultDto } from "../../dto/run-result-dto.ts";

// A minimal async-iterable that yields the given entries then (optionally) throws —
// used to simulate kv.list hitting an undeserializable row mid-stream.
function fakeListIter(entries: unknown[], throwAtEnd = false) {
  let i = 0;
  return {
    // deno-lint-ignore require-await
    async next() {
      if (i < entries.length) return { done: false, value: entries[i++] };
      if (throwAtEnd) throw new RangeError("invalid serialized data");
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

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

Deno.test("RunResult.getLatest - tolerates an undeserializable newest row (null + warns)", async () => {
  // Simulate the production wedge: the newest run row's value won't deserialize,
  // so kv.list throws while reading it. getLatest must swallow that, report "no
  // previous run", AND warn — the warn is the operator's only signal that a row
  // was skipped, so pin it too.
  const realList = kv.list.bind(kv);
  const realWarn = log.warn;
  const warnCalls: unknown[][] = [];
  (kv as { list: unknown }).list = () => fakeListIter([], true);
  (log as { warn: unknown }).warn = (...args: unknown[]) => { warnCalls.push(args); };
  try {
    const latest = await RunResult.getLatest("any-monitor");
    assertEquals(latest, null);
    assertEquals(warnCalls.length, 1);
    const msg = String(warnCalls[0][0]);
    assertStringIncludes(msg, "any-monitor");
    assertStringIncludes(msg, "invalid serialized data");
  } finally {
    (kv as { list: unknown }).list = realList;
    (log as { warn: unknown }).warn = realWarn;
  }
});

Deno.test("RunResult.save - throws when the atomic commit fails (ok:false)", async () => {
  // A dropped write must not be followed by a false "saved" log. save() inspects
  // commit().ok and throws so persistRunAndAlert surfaces the failure instead.
  const realAtomic = kv.atomic.bind(kv);
  const realError = log.error;
  const errorCalls: unknown[][] = [];
  const fakeOp: Record<string, unknown> = {};
  fakeOp.set = () => fakeOp;
  fakeOp.delete = () => fakeOp;
  fakeOp.check = () => fakeOp;
  fakeOp.commit = () => Promise.resolve({ ok: false });
  (kv as { atomic: unknown }).atomic = () => fakeOp;
  (log as { error: unknown }).error = (...args: unknown[]) => { errorCalls.push(args); };
  try {
    const dto: RunResultDto = {
      runId: crypto.randomUUID(), monitorId: "save-fail", observed: 1, passed: true,
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    await assertRejects(() => new RunResult().save(dto), Error, "Failed to persist run");
    // The throw alone proves the mechanism; this proves the failure was actually
    // logged at the call site (the ❌ line carrying the monitorId), so no false
    // "saved" can slip through unrecorded.
    assertEquals(errorCalls.length, 1);
    assertStringIncludes(String(errorCalls[0][0]), "save-fail");
  } finally {
    (kv as { atomic: unknown }).atomic = realAtomic;
    (log as { error: unknown }).error = realError;
  }
});

Deno.test("RunResult.scanWindow - returns runs newest-first within the window, counts passes", async () => {
  const monitorId = `scan-happy-${crypto.randomUUID()}`;
  const rows: RunResultDto[] = [
    { runId: crypto.randomUUID(), monitorId, observed: 1, passed: true,  timestamp: "2026-03-01T00:00:00.000Z" },
    { runId: crypto.randomUUID(), monitorId, observed: 2, passed: false, timestamp: "2026-03-02T00:00:00.000Z" },
    { runId: crypto.randomUUID(), monitorId, observed: 3, passed: true,  timestamp: "2026-03-03T00:00:00.000Z" },
  ];
  for (const r of rows) await new RunResult().save(r);
  try {
    // Cutoff at 03-02 excludes the 03-01 row; remaining come back newest-first.
    const res = await RunResult.scanWindow(monitorId, "2026-03-02T00:00:00.000Z", 500);
    assertEquals(res.runs.map((r) => r.observed), [3, 2]);
    assertEquals(res.passed, 1);
    assertEquals(res.corrupt.length, 0);
    assertEquals(res.capped, false);
    // A cap smaller than the in-window count marks the result capped.
    const capRes = await RunResult.scanWindow(monitorId, "2026-01-01T00:00:00.000Z", 2);
    assertEquals(capRes.runs.length, 2);
    assertEquals(capRes.capped, true);
  } finally {
    for (const r of rows) {
      await kv.delete(["run", monitorId, r.timestamp, r.runId]);
      await kv.delete(["run_idx", monitorId, r.timestamp, r.runId]);
    }
  }
});

Deno.test("RunResult.scanWindow - per-row batching keeps newer rows and recovers the exact key from run_idx", async () => {
  // Fully faked KV: the run list yields two good rows then throws (the corrupt
  // row); the run_idx list yields the corrupt row's key; re-reading that row
  // throws → exact:true. Proves (a) good rows survive, (b) truncation at the bad
  // row, (c) the precise key is recovered for a one-click purge.
  const monitorId = "scan-corrupt";
  const corruptTs = "2026-04-01T00:00:00.000Z";
  const corruptRunId = crypto.randomUUID();
  const good = [
    { key: ["run", monitorId, "2026-04-03T00:00:00.000Z", "a"], value: { runId: "a", monitorId, observed: 30, passed: true,  timestamp: "2026-04-03T00:00:00.000Z" } },
    { key: ["run", monitorId, "2026-04-02T00:00:00.000Z", "b"], value: { runId: "b", monitorId, observed: 20, passed: false, timestamp: "2026-04-02T00:00:00.000Z" } },
  ];
  const realList = kv.list.bind(kv);
  const realGet = kv.get.bind(kv);
  (kv as { list: unknown }).list = (selector: { prefix: unknown[] }) =>
    selector.prefix[0] === "run_idx"
      ? fakeListIter([{ key: ["run_idx", monitorId, corruptTs, corruptRunId], value: { passed: false } }])
      : fakeListIter(good, true);
  (kv as { get: unknown }).get = (key: unknown[]) =>
    key[0] === "run" && key[2] === corruptTs
      ? Promise.reject(new RangeError("invalid serialized data"))
      : realGet(key as Parameters<typeof realGet>[0]);
  try {
    const res = await RunResult.scanWindow(monitorId, "2026-01-01T00:00:00.000Z", 500);
    assertEquals(res.runs.map((r) => r.observed), [30, 20]);
    assertEquals(res.corrupt, [{ exact: true, timestamp: corruptTs, runId: corruptRunId }]);
    // Pass-counting still runs when the walk ends in a throw (observed:30 passed),
    // and a corrupt truncation isn't mis-reported as a cap.
    assertEquals(res.passed, 1);
    assertEquals(res.capped, false);
  } finally {
    (kv as { list: unknown }).list = realList;
    (kv as { get: unknown }).get = realGet;
  }
});

Deno.test("RunResult.scanWindow - suppresses a dismissed legacy (unrecoverable) corrupt banner", async () => {
  // run_idx neighbour reads fine → the orphan is legacy (exact:false). It shows
  // unless the monitor's corrupt banner has been dismissed.
  const monitorId = "scan-legacy";
  const realList = kv.list.bind(kv);
  const realGet = kv.get.bind(kv);
  let dismissed = false;
  (kv as { list: unknown }).list = (selector: { prefix: unknown[] }) =>
    selector.prefix[0] === "run_idx"
      ? fakeListIter([{ key: ["run_idx", monitorId, "2026-04-02T00:00:00.000Z", "b"], value: { passed: true } }])
      : fakeListIter([{ key: ["run", monitorId, "2026-04-03T00:00:00.000Z", "a"], value: { runId: "a", monitorId, observed: 9, passed: true, timestamp: "2026-04-03T00:00:00.000Z" } }], true);
  (kv as { get: unknown }).get = (key: unknown[]) => {
    if (key[0] === "run_corrupt_ack") return Promise.resolve({ value: dismissed ? { dismissedAt: "x" } : null });
    if (key[0] === "run") return Promise.resolve({ value: { runId: "b", monitorId, observed: 1, passed: true, timestamp: "2026-04-02T00:00:00.000Z" } });
    return realGet(key as Parameters<typeof realGet>[0]);
  };
  try {
    const shown = await RunResult.scanWindow(monitorId, "2026-01-01T00:00:00.000Z", 500);
    assertEquals(shown.corrupt.length, 1);
    assertEquals(shown.corrupt[0].exact, false);
    // Full shape on the corrupt path: the single observed:9 row counts as a pass,
    // and the truncation is not a cap.
    assertEquals(shown.passed, 1);
    assertEquals(shown.capped, false);
    dismissed = true;
    const hidden = await RunResult.scanWindow(monitorId, "2026-01-01T00:00:00.000Z", 500);
    assertEquals(hidden.corrupt.length, 0);
  } finally {
    (kv as { list: unknown }).list = realList;
    (kv as { get: unknown }).get = realGet;
  }
});

Deno.test("RunResult.purge - deletes the run and its run_idx sidecar by key, idempotently", async () => {
  const monitorId = `purge-${crypto.randomUUID()}`;
  const dto: RunResultDto = {
    runId: crypto.randomUUID(), monitorId, observed: 1, passed: true,
    timestamp: "2026-05-01T00:00:00.000Z",
  };
  await new RunResult().save(dto);
  try {
    assertExists((await kv.get(["run", monitorId, dto.timestamp, dto.runId])).value);
    assertExists((await kv.get(["run_idx", monitorId, dto.timestamp, dto.runId])).value);
    await RunResult.purge(monitorId, dto.timestamp, dto.runId);
    assertEquals((await kv.get(["run", monitorId, dto.timestamp, dto.runId])).value, null);
    assertEquals((await kv.get(["run_idx", monitorId, dto.timestamp, dto.runId])).value, null);
    // Idempotent: purging an already-gone key does not throw.
    await RunResult.purge(monitorId, dto.timestamp, dto.runId);
  } finally {
    await kv.delete(["run", monitorId, dto.timestamp, dto.runId]);
    await kv.delete(["run_idx", monitorId, dto.timestamp, dto.runId]);
  }
});

Deno.test("RunResult.dismissCorrupt / isCorruptDismissed - round-trip", async () => {
  const monitorId = `dismiss-${crypto.randomUUID()}`;
  try {
    assertEquals(await RunResult.isCorruptDismissed(monitorId), false);
    await RunResult.dismissCorrupt(monitorId);
    assertEquals(await RunResult.isCorruptDismissed(monitorId), true);
  } finally {
    await kv.delete(["run_corrupt_ack", monitorId]);
  }
});
