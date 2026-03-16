import type { MonitorIdDto } from "../../dto/monitor-id-dto.ts";
import type { CheckDto } from "../../dto/check-dto.ts";
import { Check } from "../../impure/check/check.ts";

export async function getCheck(input: MonitorIdDto): Promise<CheckDto> {
  console.log("🚀 check.get", input.monitorId);
  const check = new Check();
  const result = await check.get(input.monitorId);
  console.log("✅ check.get", result.monitorId);
  return result;
}
