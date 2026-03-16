import type { ConfigureCheckDto } from "../../dto/configure-check-dto.ts";
import type { CheckDto } from "../../dto/check-dto.ts";
import { Monitor } from "../../impure/monitor/monitor.ts";
import { Check } from "../../impure/check/check.ts";
import { Schedule } from "../../pure/schedule/schedule.ts";

export async function configureCheck(input: ConfigureCheckDto): Promise<CheckDto> {
  console.log("🚀 check.configure", input.monitorId);
  const monitor = new Monitor();
  await monitor.get(input.monitorId); // throws not-found if monitor doesn't exist
  Schedule.validate(input);           // throws invalid-cron if cron is malformed
  const check = Check.build(input);
  const checkDto = check.toDto();
  const result = await check.upsert(checkDto);
  console.log("✅ check.configure", result.monitorId, result.cron);
  return result;
}
