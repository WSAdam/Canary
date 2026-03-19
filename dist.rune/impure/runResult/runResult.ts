import { kv } from "../_kv.ts";
import type { RunResultDto } from "../../dto/run-result-dto.ts";

export class RunResult {
  private data?: RunResultDto;

  static build(monitorId: string, observed: number, passed: boolean, monitorName?: string, error?: string, captures?: Record<string, string>): RunResult {
    const rr = new RunResult();
    rr.data = {
      runId: crypto.randomUUID(),
      monitorId,
      monitorName,
      observed,
      passed,
      timestamp: new Date().toISOString(),
      error,
      captures,
    };
    return rr;
  }

  toDto(): RunResultDto {
    if (!this.data) throw new Error("RunResult not initialized — call RunResult.build() first");
    return this.data;
  }

  async save(dto: RunResultDto): Promise<void> {
    await kv.set(["run", dto.monitorId, dto.timestamp], dto);
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
