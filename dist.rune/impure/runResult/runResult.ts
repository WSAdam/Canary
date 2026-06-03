import { kv } from "../_kv.ts";
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
    await kv.set(["run", dto.monitorId, dto.timestamp, dto.runId], dto);
  }

  static async getLatest(monitorId: string): Promise<RunResultDto | null> {
    const iter = kv.list<RunResultDto>(
      { prefix: ["run", monitorId] },
      { reverse: true, limit: 1 },
    );
    for await (const entry of iter) {
      return entry.value;
    }
    return null;
  }
}
