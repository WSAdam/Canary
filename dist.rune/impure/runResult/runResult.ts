import { kv } from "../_kv.ts";
import { log } from "../_log.ts";
import type { RunResultDto, RunRequestDetailDto, RunResponseDetailDto } from "../../dto/run-result-dto.ts";

export interface RunResultExtra {
  // Reuse the run's correlation id so logs and stored history share one id.
  runId?: string;
  request?: RunRequestDetailDto;
  response?: RunResponseDetailDto;
}

// One row in a Reports window scan — a lean projection of RunResultDto.
export interface ScanRunRow {
  runId: string;
  timestamp: string;
  passed: boolean;
  observed: number;
  error?: string;
  captures?: Record<string, string>;
  // Whether full request/response detail was captured (failed runs only).
  hasDetail: boolean;
}

// An undeserializable row surfaced to the Reports UI. `exact` rows carry the
// precise key recovered from run_idx (one-click purge); legacy rows have no
// recoverable key and are bracketed by the surrounding timestamps instead.
export type CorruptEntry =
  | { exact: true; timestamp: string; runId: string }
  | { exact: false; newerThan: string | null; olderThan: string | null };

export interface ScanWindowResult {
  runs: ScanRunRow[];
  passed: number;
  corrupt: CorruptEntry[];
  capped: boolean;
}

export class RunResult {
  private data?: RunResultDto;

  static build(
    monitorId: string,
    observed: number,
    passed: boolean,
    monitorName?: string,
    error?: string,
    captures?: Record<string, string>,
    extra?: RunResultExtra,
  ): RunResult {
    const rr = new RunResult();
    rr.data = {
      runId: extra?.runId ?? crypto.randomUUID(),
      monitorId,
      monitorName,
      observed,
      passed,
      timestamp: new Date().toISOString(),
      error,
      captures,
      request: extra?.request,
      response: extra?.response,
    };
    return rr;
  }

  toDto(): RunResultDto {
    if (!this.data) throw new Error("RunResult not initialized — call RunResult.build() first");
    return this.data;
  }

  async save(dto: RunResultDto): Promise<void> {
    // runId is the final key segment so two runs in the same millisecond don't
    // overwrite each other; timestamp stays primary so reverse-order still
    // returns the newest run.
    //
    // run_idx is a tiny sidecar mirroring just the key (+ passed flag). It can't
    // exceed KV's deserialize size limit, so it stays readable even if the full
    // run value ever becomes undeserializable — letting the Reports tab recover
    // the exact key of a corrupt row and purge it. Written atomically with the
    // run so the index never diverges from the rows it points at.
    const res = await kv.atomic()
      .set(["run", dto.monitorId, dto.timestamp, dto.runId], dto)
      .set(["run_idx", dto.monitorId, dto.timestamp, dto.runId], { passed: dto.passed })
      .commit();
    if (!res.ok) {
      // A failed commit means neither the run nor its run_idx sidecar landed.
      // Throw so the caller can't log a false "✅ saved" — a silently dropped run
      // is exactly the missing-sidecar / legacy-orphan state we work to avoid.
      log.error(
        `❌ RunResult.save: atomic commit failed for monitor=${dto.monitorId} ` +
          `runId=${dto.runId} — run not persisted`,
      );
      throw new Error(`Failed to persist run ${dto.runId} for monitor ${dto.monitorId}`);
    }
  }

  static async getLatest(monitorId: string): Promise<RunResultDto | null> {
    try {
      const iter = kv.list<RunResultDto>(
        { prefix: ["run", monitorId] },
        { reverse: true, limit: 1 },
      );
      for await (const entry of iter) {
        return entry.value;
      }
      return null;
    } catch (e) {
      // KV can't advance its cursor past an undeserializable newest row, so older
      // rows are unreadable here too — treat it as "no previous run" so the current
      // run still persists a fresh readable row and un-blocks the monitor.
      log.warn(
        `⚠️ RunResult.getLatest: newest run for ${monitorId} is unreadable — ` +
          `treating as no previous run — ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  // Walk a monitor's run history newest-first within a window. Reads one row at a
  // time (batchSize:1) so a single undeserializable row truncates history at that
  // row instead of wiping the whole batch. The bad row is surfaced in `corrupt`
  // with its exact key recovered from run_idx when possible (one-click purge), or
  // suppressed when the user has dismissed an unrecoverable legacy banner.
  static async scanWindow(
    monitorId: string,
    cutoff: string,
    cap: number,
  ): Promise<ScanWindowResult> {
    const runs: ScanRunRow[] = [];
    let passed = 0;
    const corrupt: CorruptEntry[] = [];
    const iter = kv.list<RunResultDto>(
      { prefix: ["run", monitorId] },
      { reverse: true, limit: cap, batchSize: 1 },
    );
    try {
      while (true) {
        const res = await iter.next();
        if (res.done) break;
        const r = res.value.value;
        if (r.timestamp < cutoff) break; // reached the window edge — older runs follow
        if (r.passed) passed++;
        runs.push({
          runId: r.runId, // lets the SPA drill into a failed run's request/response
          timestamp: r.timestamp,
          passed: r.passed,
          observed: r.observed,
          error: r.error,
          captures: r.captures,
          hasDetail: !!(r.request || r.response),
        });
      }
    } catch (e) {
      log.warn(
        `⚠️ RunResult.scanWindow: run history for ${monitorId} truncated at an ` +
          `unreadable row — ${e instanceof Error ? e.message : String(e)}`,
      );
      const newerThan = runs.length ? runs[runs.length - 1].timestamp : null;
      const entry = await RunResult.resolveCorruptEntry(monitorId, newerThan);
      // exact rows are one-click purgeable, so always surface them. A legacy
      // (exact:false) row can't be deleted — its key is unrecoverable — so honor a
      // user dismissal and suppress its banner once acknowledged.
      if (entry.exact || !(await RunResult.isCorruptDismissed(monitorId))) {
        corrupt.push(entry);
      }
    }
    const capped = cap > 0 && runs.length === cap && runs[runs.length - 1].timestamp >= cutoff;
    return { runs, passed, corrupt, capped };
  }

  // Identify the orphan row that truncated a scanWindow walk. The scan stopped at
  // a row just older than `newerThan` (the last good row's timestamp, or null when
  // even the newest row is corrupt). Recover its exact key from run_idx (the tiny
  // sidecar that still decodes): the index entry immediately older than `newerThan`
  // is the offending row. Confirm by re-reading the full value — if that throws (or
  // the row is gone) we have the exact key for a one-click purge; if it reads fine
  // the orphan predates the index (legacy) and we fall back to a timestamp bracket.
  private static async resolveCorruptEntry(
    monitorId: string,
    newerThan: string | null,
  ): Promise<CorruptEntry> {
    const idxSelector = newerThan
      ? { prefix: ["run_idx", monitorId], end: ["run_idx", monitorId, newerThan] }
      : { prefix: ["run_idx", monitorId] };
    let candidate: { timestamp: string; runId: string } | null = null;
    for await (const idx of kv.list(idxSelector, { reverse: true, limit: 1 })) {
      candidate = { timestamp: idx.key[2] as string, runId: idx.key[3] as string };
    }
    if (!candidate) return { exact: false, newerThan, olderThan: null };
    try {
      const full = await kv.get<RunResultDto>(["run", monitorId, candidate.timestamp, candidate.runId]);
      return full.value === null
        ? { exact: true, timestamp: candidate.timestamp, runId: candidate.runId } // stale index → purge cleans it
        : { exact: false, newerThan, olderThan: candidate.timestamp };
    } catch {
      return { exact: true, timestamp: candidate.timestamp, runId: candidate.runId };
    }
  }

  // Delete a single run row by exact key, plus its run_idx sidecar — by key only,
  // never reading the value, so it works even when the row is undeserializable.
  // This is how a corrupt run surfaced on the Reports tab gets removed. Idempotent.
  static async purge(monitorId: string, timestamp: string, runId: string): Promise<boolean> {
    const res = await kv.atomic()
      .delete(["run", monitorId, timestamp, runId])
      .delete(["run_idx", monitorId, timestamp, runId])
      .commit();
    if (!res.ok) {
      // Symmetric with save(): don't let the caller report a false success. The
      // Reports "Purge row" button surfaces this as a retryable failure instead of
      // a 200 that leaves the corrupt banner to reappear on reload.
      log.warn(`⚠️ RunResult.purge: atomic delete failed for monitor=${monitorId} runId=${runId}`);
    }
    return res.ok;
  }

  // Acknowledge an unrecoverable (pre-run_idx) corrupt row so the Reports tab stops
  // surfacing its banner. The row can't be deleted (its exact key is unrecoverable);
  // this only suppresses the warning. Keyed per monitor.
  static async dismissCorrupt(monitorId: string): Promise<void> {
    await kv.set(["run_corrupt_ack", monitorId], { dismissedAt: new Date().toISOString() });
  }

  static async isCorruptDismissed(monitorId: string): Promise<boolean> {
    return (await kv.get(["run_corrupt_ack", monitorId])).value !== null;
  }
}
