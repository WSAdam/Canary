import type { MonitorIdDto } from "../../dto/monitor-id-dto.ts";
import type { CheckDto } from "../../dto/check-dto.ts";
import { Check } from "../../impure/check/check.ts";
import { log } from "../../impure/_log.ts";

export async function getCheck(input: MonitorIdDto): Promise<CheckDto> {
  log.debug("🚀 check.get", input.monitorId);
  const check = new Check();
  const result = await check.get(input.monitorId);
  log.debug("✅ check.get", result.monitorId);
  return result;
}
