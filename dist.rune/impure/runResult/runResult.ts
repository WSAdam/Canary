import { kv } from "../_kv.ts";
import { log } from "../_log.ts";
import type { RunResultDto, RunRequestDetailDto, RunResponseDetailDto } from "../../dto/run-result-dto.ts";

export interface RunResultExtra {
  // Reuse the run's correlation id so logs and stored history share one id.
  runId?: string;
  request?: RunRequestDetailDto;
  response?: RunResponseDetailDto;
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
    await kv.atomic()
      .set(["run", dto.monitorId, dto.timestamp, dto.runId], dto)
      .set(["run_idx", dto.monitorId, dto.timestamp, dto.runId], { passed: dto.passed })
      .commit();
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
      // A corrupt/undeserializable NEWEST run row must never wedge the run path.
      // KV throws while deserializing it and cannot advance its cursor past it,
      // so we can't read older rows here either — treat it as "no previous run".
      // The current run then still persists (writing a fresh, readable, indexed
      // newest row), which un-blocks every subsequent getLatest call. The only
      // cost is recovery detection possibly re-alerting once — far better than a
      // monitor that silently stops recording and alerting. See the Reports tab's
      // corrupt-row purge for cleaning the bad row up.
      log.warn(
        `⚠️ RunResult.getLatest: newest run for ${monitorId} is unreadable — ` +
          `treating as no previous run — ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }
}
