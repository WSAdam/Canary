import type { MonitorIdDto } from "../../dto/monitor-id-dto.ts";
import type { MonitorDto } from "../../dto/monitor-dto.ts";
import { Monitor } from "../../impure/monitor/monitor.ts";
import { log } from "../../impure/_log.ts";

export async function getMonitor(input: MonitorIdDto): Promise<MonitorDto> {
  log.debug("🚀 monitor.get", input.monitorId);
  const monitor = new Monitor();
  const result = await monitor.get(input.monitorId);
  log.debug("✅ monitor.get", result.name);
  return result;
}
