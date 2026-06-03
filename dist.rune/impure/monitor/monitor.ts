import { kv } from "../_kv.ts";
import type { CreateMonitorDto } from "../../dto/create-monitor-dto.ts";
import type { MonitorDto } from "../../dto/monitor-dto.ts";
import type { MonitorListDto } from "../../dto/monitor-list-dto.ts";
import { CanaryError } from "../../dto/_shared.ts";
import { log } from "../_log.ts";

export class Monitor {
  static async checkUnique(name: string): Promise<void> {
    log.debug(`🔍 monitor.checkUnique: checking name="${name}"`);
    const result = await kv.get<string>(["monitor_name", name], { consistency: "strong" });
    log.debug(`🔍 monitor.checkUnique: result=${result.value === null ? "null (available)" : `"${result.value}" (taken)`}`);
    if (result.value !== null) {
      throw new CanaryError("duplicate-name", `Monitor with name "${name}" already exists`, 409);
    }
  }

  async insert(dto: CreateMonitorDto): Promise<MonitorDto> {
    const monitorId = crypto.randomUUID();
    const monitor: MonitorDto = { monitorId, name: dto.name, description: dto.description };
    log.debug(`🚀 monitor.insert: name="${dto.name}" id=${monitorId}`);
    const res = await kv.atomic()
      .check({ key: ["monitor_name", dto.name], versionstamp: null })
      .set(["monitor", monitorId], monitor)
      .set(["monitor_name", dto.name], monitorId)
      .commit();
    if (!res.ok) {
      log.debug(`🔍 monitor.insert: atomic commit failed (name taken)`);
      throw new CanaryError("duplicate-name", `Monitor with name "${dto.name}" already exists`, 409);
    }
    log.debug(`🔍 monitor.insert: atomic commit ok versionstamp=${res.versionstamp}`);
    // Immediate read-back to verify KV persistence
    const verify = await kv.get<MonitorDto>(["monitor", monitorId], { consistency: "strong" });
    if (verify.value === null) {
      log.error(`❌ monitor.insert: READ-BACK FAILED — write did not persist! KV may not be connected to hosted store.`);
    } else {
      log.debug(`✅ monitor.insert: read-back confirmed "${verify.value.name}" (${monitorId}) versionstamp=${verify.versionstamp}`);
    }
    return monitor;
  }

  async list(): Promise<MonitorListDto> {
    const monitors: MonitorDto[] = [];
    let totalKeys = 0;
    log.debug(`🚀 monitor.list: starting kv.list prefix=["monitor"] consistency=strong`);
    for await (const entry of kv.list<MonitorDto>({ prefix: ["monitor"] }, { consistency: "strong" })) {
      totalKeys++;
      const keyStr = `[${entry.key.map(k => JSON.stringify(k)).join(", ")}]`;
      log.debug(`🔍 monitor.list: key=${keyStr} length=${entry.key.length} key[0]=${JSON.stringify(entry.key[0])}`);
      if (entry.key.length === 2 && entry.key[0] === "monitor") {
        const m = entry.value as MonitorDto;
        log.debug(`✅ monitor.list: matched monitor id=${m.monitorId} name="${m.name}"`);
        monitors.push(m);
      } else {
        log.debug(`⚠️ monitor.list: skipping key — did not match filter`);
      }
    }
    log.debug(`✅ monitor.list: scanned ${totalKeys} total keys, found ${monitors.length} monitors`);
    return { monitors };
  }

  async get(monitorId: string): Promise<MonitorDto> {
    log.debug(`🔍 monitor.get: key=["monitor", "${monitorId}"] consistency=strong`);
    const result = await kv.get<MonitorDto>(["monitor", monitorId], { consistency: "strong" });
    if (result.value === null) {
      log.debug(`❌ monitor.get: NOT FOUND for ${monitorId}`);
      const existing: string[] = [];
      for await (const entry of kv.list<MonitorDto>({ prefix: ["monitor"] }, { consistency: "strong" })) {
        if (entry.key.length === 2 && entry.key[0] === "monitor") existing.push(entry.key[1] as string);
      }
      log.debug(`❌ monitor.get: existing monitor IDs in KV: [${existing.join(", ") || "NONE"}]`);
      throw new CanaryError("not-found", `Monitor "${monitorId}" not found`, 404);
    }
    log.debug(`✅ monitor.get: found "${result.value.name}" versionstamp=${result.versionstamp}`);
    return result.value;
  }
}
