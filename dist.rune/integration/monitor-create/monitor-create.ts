import type { CreateMonitorDto } from "../../dto/create-monitor-dto.ts";
import type { MonitorDto } from "../../dto/monitor-dto.ts";
import { MAX_MONITOR_DESCRIPTION_LENGTH, MAX_MONITOR_NAME_LENGTH, Monitor } from "../../impure/monitor/monitor.ts";
import { requireMaxLength, requireString } from "../../dto/_shared.ts";
import { log } from "../../impure/_log.ts";

export async function createMonitor(input: CreateMonitorDto): Promise<MonitorDto> {
  log.debug("🚀 monitor.create", input?.name);
  // Validate the name before it reaches KV: a missing/non-string name would hit
  // kv.get(["monitor_name", undefined]) as an invalid key part (raw TypeError →
  // 500), and an empty/oversized name is not a meaningful monitor.
  const name = requireMaxLength(requireString(input?.name, "name").trim(), "name", MAX_MONITOR_NAME_LENGTH);
  const description = typeof input?.description === "string"
    ? requireMaxLength(input.description, "description", MAX_MONITOR_DESCRIPTION_LENGTH)
    : "";
  // Coerce to a known type: only "relay" opts out of the default, so an unknown
  // value from a direct caller can't persist a malformed monitor type.
  const type = input?.type === "relay" ? "relay" : "check";
  await Monitor.checkUnique(name);
  const monitor = new Monitor();
  const result = await monitor.insert({ name, description, type });
  log.debug("✅ monitor.create", result.monitorId);
  return result;
}
