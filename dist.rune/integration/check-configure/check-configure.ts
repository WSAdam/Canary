import type { ConfigureCheckDto } from "../../dto/configure-check-dto.ts";
import type { CheckDto } from "../../dto/check-dto.ts";
import { Check } from "../../impure/check/check.ts";
import { Schedule } from "../../pure/schedule/schedule.ts";
import { log } from "../../impure/_log.ts";

export async function configureCheck(input: ConfigureCheckDto): Promise<CheckDto> {
  log.debug("🚀 check.configure", input.monitorId);
  Schedule.validate(input);           // throws invalid-cron if cron is malformed
  const check = Check.build(input);
  const checkDto = check.toDto();
  const result = await check.upsert(checkDto);
  log.debug("✅ check.configure", result.monitorId, result.cron);
  return result;
}
