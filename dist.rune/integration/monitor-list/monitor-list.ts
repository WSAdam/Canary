import type { MonitorListDto } from "../../dto/monitor-list-dto.ts";
import { Monitor } from "../../impure/monitor/monitor.ts";

export async function listMonitors(): Promise<MonitorListDto> {
  console.log("🚀 monitor.list");
  const monitor = new Monitor();
  const result = await monitor.list();
  console.log("✅ monitor.list", result.monitors.length, "monitors");
  return result;
}
