import type { CreateMonitorDto } from "../../dto/create-monitor-dto.ts";
import type { MonitorDto } from "../../dto/monitor-dto.ts";
import { Monitor } from "../../impure/monitor/monitor.ts";
import { log } from "../../impure/_log.ts";

export async function createMonitor(input: CreateMonitorDto): Promise<MonitorDto> {
  log.debug("🚀 monitor.create", input.name);
  await Monitor.checkUnique(input.name);
  const monitor = new Monitor();
  const result = await monitor.insert(input);
  log.debug("✅ monitor.create", result.monitorId);
  return result;
}
