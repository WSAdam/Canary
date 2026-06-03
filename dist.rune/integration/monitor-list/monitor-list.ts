import type { MonitorListDto } from "../../dto/monitor-list-dto.ts";
import { Monitor } from "../../impure/monitor/monitor.ts";
import { log } from "../../impure/_log.ts";

export async function listMonitors(): Promise<MonitorListDto> {
  log.debug("🚀 monitor.list");
  const monitor = new Monitor();
  const result = await monitor.list();
  log.debug("✅ monitor.list", result.monitors.length, "monitors");
  return result;
}
