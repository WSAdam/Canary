import { kv } from "../_kv.ts";
import type { CreateMonitorDto } from "../../dto/create-monitor-dto.ts";
import type { MonitorDto } from "../../dto/monitor-dto.ts";
import type { MonitorListDto } from "../../dto/monitor-list-dto.ts";
import { CanaryError } from "../../dto/_shared.ts";

export class Monitor {
  static async checkUnique(name: string): Promise<void> {
    const result = await kv.get<string>(["monitor_name", name], { consistency: "strong" });
    if (result.value !== null) {
      throw new CanaryError("duplicate-name", `Monitor with name "${name}" already exists`, 409);
    }
  }

  async insert(dto: CreateMonitorDto): Promise<MonitorDto> {
    const monitorId = crypto.randomUUID();
    const monitor: MonitorDto = {
      monitorId,
      name: dto.name,
      description: dto.description,
    };
    const res = await kv.atomic()
      .check({ key: ["monitor_name", dto.name], versionstamp: null })
      .set(["monitor", monitorId], monitor)
      .set(["monitor_name", dto.name], monitorId)
      .commit();
    if (!res.ok) {
      throw new CanaryError("duplicate-name", `Monitor with name "${dto.name}" already exists`, 409);
    }
    return monitor;
  }

  async list(): Promise<MonitorListDto> {
    const monitors: MonitorDto[] = [];
    for await (const entry of kv.list<MonitorDto>({ prefix: ["monitor"] }, { consistency: "strong" })) {
      if (entry.key.length === 2 && entry.key[0] === "monitor") {
        monitors.push(entry.value);
      }
    }
    return { monitors };
  }

  async get(monitorId: string): Promise<MonitorDto> {
    console.log(`🔍 monitor.get: looking up ["monitor", "${monitorId}"]`);
    const result = await kv.get<MonitorDto>(["monitor", monitorId], { consistency: "strong" });
    if (result.value === null) {
      // Dump existing monitor keys to help diagnose stale-ID issues
      const existing: string[] = [];
      for await (const entry of kv.list<MonitorDto>({ prefix: ["monitor"] }, { consistency: "strong" })) {
        if (entry.key.length === 2 && entry.key[0] === "monitor") {
          existing.push(entry.key[1] as string);
        }
      }
      console.log(`❌ monitor.get: NOT FOUND. Existing monitor IDs in KV: [${existing.join(", ")}]`);
      throw new CanaryError("not-found", `Monitor "${monitorId}" not found`, 404);
    }
    console.log(`✅ monitor.get: found "${result.value.name}" (${monitorId})`);
    return result.value;
  }
}
