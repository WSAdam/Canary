import type { MonitorIdDto } from "../../dto/monitor-id-dto.ts";
import type { MonitorDto } from "../../dto/monitor-dto.ts";
import { Monitor } from "../../impure/monitor/monitor.ts";

export async function getMonitor(input: MonitorIdDto): Promise<MonitorDto> {
  console.log("🚀 monitor.get", input.monitorId);
  const monitor = new Monitor();
  const result = await monitor.get(input.monitorId);
  console.log("✅ monitor.get", result.name);
  return result;
}
