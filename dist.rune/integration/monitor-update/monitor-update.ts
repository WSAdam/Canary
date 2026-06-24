import type { UpdateMonitorDto } from "../../dto/update-monitor-dto.ts";
import type { MonitorDto } from "../../dto/monitor-dto.ts";
import { MAX_MONITOR_DESCRIPTION_LENGTH, MAX_MONITOR_NAME_LENGTH, Monitor } from "../../impure/monitor/monitor.ts";
import { CanaryError, requireMaxLength } from "../../dto/_shared.ts";
import { log } from "../../impure/_log.ts";

export async function updateMonitor(input: UpdateMonitorDto): Promise<MonitorDto> {
  log.debug("🚀 monitor.update", input.monitorId, input.name);
  // PATCH semantics: name/description may be omitted (Monitor.update merges over
  // the existing record). But when name IS supplied it must be a valid bounded,
  // non-empty string so it can't reach KV as an invalid/oversized key part.
  const patch: UpdateMonitorDto = { ...input };
  if (patch.name !== undefined && patch.name !== null) {
    if (typeof patch.name !== "string" || patch.name.trim() === "") {
      throw new CanaryError("validation-error", "name must be a non-empty string", 400);
    }
    patch.name = requireMaxLength(patch.name.trim(), "name", MAX_MONITOR_NAME_LENGTH);
  }
  if (patch.description !== undefined && patch.description !== null) {
    if (typeof patch.description !== "string") {
      throw new CanaryError("validation-error", "description must be a string", 400);
    }
    requireMaxLength(patch.description, "description", MAX_MONITOR_DESCRIPTION_LENGTH);
  }
  const monitor = new Monitor();
  const result = await monitor.update(patch);
  log.debug("✅ monitor.update", result.monitorId);
  return result;
}
