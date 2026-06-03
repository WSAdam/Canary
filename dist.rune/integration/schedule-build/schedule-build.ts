import type { ScheduleInputDto } from "../../dto/schedule-input-dto.ts";
import type { ScheduleDto } from "../../dto/schedule-dto.ts";
import { Schedule } from "../../pure/schedule/schedule.ts";
import { log } from "../../impure/_log.ts";

export function buildSchedule(input: ScheduleInputDto): ScheduleDto {
  log.debug("🚀 schedule.build", input.frequency, input.timeOfDay, input.daysOfWeek);
  const schedule = Schedule.fromInput(input);
  const result = schedule.toCron();
  log.debug("✅ schedule.build →", result.cron);
  return result;
}
