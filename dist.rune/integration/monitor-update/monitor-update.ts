import type { UpdateMonitorDto } from "../../dto/update-monitor-dto.ts";
import type { MonitorDto } from "../../dto/monitor-dto.ts";
import { Monitor } from "../../impure/monitor/monitor.ts";
import { log } from "../../impure/_log.ts";

export async function updateMonitor(input: UpdateMonitorDto): Promise<MonitorDto> {
  log.debug("🚀 monitor.update", input.monitorId, input.name);
  const monitor = new Monitor();
  const result = await monitor.update(input);
  log.debug("✅ monitor.update", result.monitorId);
  return result;
}
