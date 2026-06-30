import { kv } from "../_kv.ts";
import type { CreateMonitorDto } from "../../dto/create-monitor-dto.ts";
import type { UpdateMonitorDto } from "../../dto/update-monitor-dto.ts";
import type { MonitorDto } from "../../dto/monitor-dto.ts";
import type { MonitorListDto } from "../../dto/monitor-list-dto.ts";
import { CanaryError } from "../../dto/_shared.ts";
import { log } from "../_log.ts";

// Bound the name so it can't blow past Deno KV's ~2 KiB key-size limit when used
// as the ["monitor_name", name] index key part.
export const MAX_MONITOR_NAME_LENGTH = 200;

// Bound the description so an oversized value (stored in the ["monitor", id] KV
// VALUE) can't blow past Deno KV's ~64 KiB per-value limit as an opaque 500 —
// it's surfaced as a clean 400 at the boundary instead (mirrors the name cap).
export const MAX_MONITOR_DESCRIPTION_LENGTH = 4000;

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
    const monitor: MonitorDto = { monitorId, name: dto.name, description: dto.description, type: dto.type ?? "check" };
    log.debug(`🚀 monitor.insert: name="${dto.name}" id=${monitorId} type=${monitor.type}`);
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

  async update(dto: UpdateMonitorDto): Promise<MonitorDto> {
    // Read with the versionstamp so the rename commit can pin the record —
    // see the atomic check below.
    const read = await kv.get<MonitorDto>(["monitor", dto.monitorId], { consistency: "strong" });
    if (read.value === null) {
      throw new CanaryError("not-found", `Monitor "${dto.monitorId}" not found`, 404);
    }
    const existing = read.value;
    // PATCH semantics: merge over the existing record so a partial body can't
    // clobber a field with undefined, and any future MonitorDto fields survive.
    const name = dto.name ?? existing.name;
    const description = dto.description ?? existing.description;
    // Normalize a legacy record's missing type → "check" so the rewritten record
    // is always well-formed; never let a rename change a monitor's type.
    const updated: MonitorDto = { ...existing, monitorId: dto.monitorId, name, description, type: existing.type ?? "check" };

    // Name unchanged → only the record needs writing (e.g. a description edit).
    // The ["monitor_name", name] index already points at this monitor.
    //
    // Still PIN the record's versionstamp: a bare kv.set here would silently
    // clobber a concurrent rename that commits between our read and write —
    // restoring the old name in the record while the rename already moved the
    // ["monitor_name", …] index, desyncing the uniqueness invariant. The check
    // forces us to observe that conflict and re-read instead of overwriting it.
    if (name === existing.name) {
      log.debug(`🚀 monitor.update: ${dto.monitorId} description-only (name unchanged)`);
      const res = await kv.atomic()
        .check({ key: ["monitor", dto.monitorId], versionstamp: read.versionstamp })
        .set(["monitor", dto.monitorId], updated)
        .commit();
      if (!res.ok) {
        log.debug(`🔍 monitor.update: ${dto.monitorId} changed concurrently during description-only update`);
        throw new CanaryError("conflict", "Monitor was modified concurrently — please retry", 409);
      }
      return updated;
    }

    // Name changed → atomically move the uniqueness index: claim the new name
    // (must be free), drop the old one, and rewrite the record in one commit so
    // a concurrent create/rename can't duplicate a name.
    //
    // Also pin the monitor record's versionstamp: two concurrent renames of THIS
    // monitor (A→B and A→C) both read existing.name="A" and both find their new
    // name free, so without this check both commit — leaving the record at one
    // name but BOTH [monitor_name,B] and [monitor_name,C] pointing at it (one a
    // phantom reservation that no record matches). The check forces the loser to
    // observe the conflict instead of silently desyncing the index.
    log.debug(`🚀 monitor.update: ${dto.monitorId} rename "${existing.name}" → "${name}"`);
    const res = await kv.atomic()
      .check({ key: ["monitor", dto.monitorId], versionstamp: read.versionstamp })
      .check({ key: ["monitor_name", name], versionstamp: null })
      .set(["monitor", dto.monitorId], updated)
      .delete(["monitor_name", existing.name])
      .set(["monitor_name", name], dto.monitorId)
      .commit();
    if (!res.ok) {
      log.debug(`🔍 monitor.update: atomic commit failed (name taken or concurrent change)`);
      throw new CanaryError("duplicate-name", `Monitor with name "${name}" already exists`, 409);
    }
    log.debug(`✅ monitor.update: ${dto.monitorId} renamed to "${name}" versionstamp=${res.versionstamp}`);
    return updated;
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
        monitors.push({ ...m, type: m.type ?? "check" }); // normalize legacy records
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
    return { ...result.value, type: result.value.type ?? "check" }; // normalize legacy records
  }
}
