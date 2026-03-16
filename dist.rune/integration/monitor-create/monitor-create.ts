import type { CreateMonitorDto } from "../../dto/create-monitor-dto.ts";
import type { MonitorDto } from "../../dto/monitor-dto.ts";
import { Monitor } from "../../impure/monitor/monitor.ts";

export async function createMonitor(input: CreateMonitorDto): Promise<MonitorDto> {
  console.log("🚀 monitor.create", input.name);
  await Monitor.checkUnique(input.name);
  const monitor = new Monitor();
  const result = await monitor.insert(input);
  console.log("✅ monitor.create", result.monitorId);
  return result;
}
