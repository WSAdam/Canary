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

  // One pass over a monitor's run history, newest-first, stopping at the window
  // edge or the cap. NEVER throws: an unreadable row ends the walk and comes back
  // in `error`, with everything read so far preserved — the caller needs that
  // partial state to identify the offending row.
  private static async collectRuns(
    monitorId: string,
    cutoff: string,
    cap: number,
    batchSize?: number,
  ): Promise<{
    runs: ScanRunRow[];
    passed: number;
    capped: boolean;
    lastGoodRunId: string | null;
    error: unknown;
  }> {
    const runs: ScanRunRow[] = [];
    let passed = 0;
    // Track the last good row's runId alongside its timestamp so corrupt-row
    // recovery can build a precise index bound when the bad row shares a
    // millisecond with the last good one.
    let lastGoodRunId: string | null = null;
    // Read one row PAST the cap so we can tell "limit hit and that's all there
    // is" from "limit hit AND more in-window rows remain". With a plain
    // limit:cap, a monitor with exactly `cap` in-window runs and none older
    // would falsely report capped:true (the UI then claims history was
    // truncated when nothing was actually omitted). The extra row is only
    // peeked — it is never collected into `runs`.
    let capped = false;
    const iter = kv.list<RunResultDto>(
      { prefix: ["run", monitorId] },
      {
        reverse: true,
        limit: cap > 0 ? cap + 1 : undefined,
        // Omitted entirely on the fast path so KV picks its own batch size.
        ...(batchSize === undefined ? {} : { batchSize }),
      },
    );
    try {
      while (true) {
        const res = await iter.next();
        if (res.done) break;
        const r = res.value.value;
        if (r.timestamp < cutoff) break; // reached the window edge — older runs follow
        if (cap > 0 && runs.length === cap) {
          // This is the (cap+1)-th in-window row — real truncation. Stop here.
          capped = true;
          break;
        }
        if (r.passed) passed++;
        lastGoodRunId = r.runId;
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
      return { runs, passed, capped, lastGoodRunId, error: e };
    }
    return { runs, passed, capped, lastGoodRunId, error: null };
  }

  /**
   * Walk a monitor's run history newest-first within a window.
   *
   * Two-tier by design. The FAST path lets Deno KV batch normally — one
   * round-trip per batch rather than per row. That is the whole difference
   * between a 30-day report rendering in well under a second and timing out at
   * 43s: 668 rows at a ~65ms round-trip each, against the SPA's 15s abort.
   *
   * The SLOW path (`batchSize: 1`) still exists because a batched read loses
   * every row that shared a batch with an undeserializable one, and which rows
   * those are is not knowable. So when the fast walk fails its partial result is
   * DISCARDED and the history is re-walked a row at a time, truncating exactly at
   * the bad row — the behaviour the Reports purge banner depends on. A corrupt
   * monitor pays one extra scan; a healthy one never pays for the guarantee.
   *
   * The bad row is surfaced in `corrupt` with its exact key recovered from
   * run_idx when possible (one-click purge), or suppressed when the user has
   * dismissed an unrecoverable legacy banner.
   */
  static async scanWindow(
    monitorId: string,
    cutoff: string,
    cap: number,
  ): Promise<ScanWindowResult> {
    const fast = await RunResult.collectRuns(monitorId, cutoff, cap);
    if (fast.error === null) {
      return { runs: fast.runs, passed: fast.passed, corrupt: [], capped: fast.capped };
    }

    // Something in this monitor's history is unreadable — re-walk precisely.
    const slow = await RunResult.collectRuns(monitorId, cutoff, cap, 1);
    if (slow.error === null) {
      // The fast failure did not reproduce row-by-row: a transient KV hiccup, or
      // a bad row OUTSIDE the window that only batching reached. The precise walk
      // is authoritative, and there is no in-window corrupt row to report.
      log.warn(
        `⚠️ RunResult.scanWindow: batched read for ${monitorId} failed but the ` +
          `row-by-row re-scan succeeded — treating as transient`,
      );
      return { runs: slow.runs, passed: slow.passed, corrupt: [], capped: slow.capped };
    }

    const corrupt: CorruptEntry[] = [];
    const e = slow.error;
    log.warn(
      `⚠️ RunResult.scanWindow: run history for ${monitorId} truncated at an ` +
        `unreadable row — ${e instanceof Error ? e.message : String(e)}`,
    );
    const newerThan = slow.runs.length ? slow.runs[slow.runs.length - 1].timestamp : null;
    try {
      const entry = await RunResult.resolveCorruptEntry(monitorId, newerThan, slow.lastGoodRunId);
      // exact rows are one-click purgeable, so always surface them. A legacy
      // (exact:false) row can't be deleted — its key is unrecoverable — so honor a
      // user dismissal and suppress its banner once acknowledged.
      if (entry.exact || !(await RunResult.isCorruptDismissed(monitorId))) {
        corrupt.push(entry);
      }
    } catch (recoveryErr) {
      // A secondary KV hiccup during recovery must NOT blank out the whole
      // Reports page — degrade this one monitor's corrupt-row detail instead.
      // Surface a non-exact banner from what we already read so the user still
      // sees that history is truncated here.
      log.warn(
        `⚠️ RunResult.scanWindow: corrupt-row recovery for ${monitorId} failed ` +
          `(non-fatal) — ${recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)}`,
      );
      corrupt.push({ exact: false, newerThan, olderThan: null });
    }
    return { runs: slow.runs, passed: slow.passed, corrupt, capped: slow.capped };
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
    lastGoodRunId: string | null = null,
  ): Promise<CorruptEntry> {
    // KV `end` is exclusive. A 3-part bound ["run_idx",mon,newerThan] sorts
    // BEFORE every 4-part key sharing that timestamp, so it would skip a corrupt
    // row that shares `newerThan`'s millisecond (runIds disambiguate same-ms
    // runs). Bound on the last good row's exact 4-part key instead so the
    // immediately-older corrupt row in the same millisecond is included.
    const idxSelector = newerThan
      ? {
        prefix: ["run_idx", monitorId],
        end: lastGoodRunId
          ? ["run_idx", monitorId, newerThan, lastGoodRunId]
          : ["run_idx", monitorId, newerThan],
      }
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
