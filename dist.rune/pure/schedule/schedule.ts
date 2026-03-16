import type { ConfigureCheckDto } from "../../dto/configure-check-dto.ts";
import type { ScheduleInputDto } from "../../dto/schedule-input-dto.ts";
import type { ScheduleDto } from "../../dto/schedule-dto.ts";
import { CanaryError } from "../../dto/_shared.ts";

const DAY_MAP: Record<string, string> = {
  sunday: "0",
  monday: "1",
  tuesday: "2",
  wednesday: "3",
  thursday: "4",
  friday: "5",
  saturday: "6",
  weekdays: "1-5",
  weekends: "0,6",
  daily: "*",
};

function parseTime(timeOfDay: string): { hour: number; minute: number } {
  const match = timeOfDay.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) {
    throw new CanaryError("invalid-time", `Invalid time format: "${timeOfDay}" — expected "H:MM AM/PM"`, 400);
  }
  let hour = parseInt(match[1]);
  const minute = parseInt(match[2]);
  const period = match[3].toUpperCase();
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
    throw new CanaryError("invalid-time", `Invalid time values in: "${timeOfDay}"`, 400);
  }
  if (period === "AM") {
    if (hour === 12) hour = 0;
  } else {
    if (hour !== 12) hour += 12;
  }
  return { hour, minute };
}

function parseDays(daysOfWeek: string): string {
  const lower = daysOfWeek.toLowerCase().trim();
  if (DAY_MAP[lower] !== undefined) return DAY_MAP[lower];
  const parts = lower.split(",").map((d) => d.trim());
  const nums = parts.map((d) => {
    if (DAY_MAP[d] === undefined) {
      throw new CanaryError("invalid-time", `Unknown day: "${d}"`, 400);
    }
    return DAY_MAP[d];
  });
  return nums.join(",");
}

export class Schedule {
  private constructor(private readonly cronStr: string) {}

  static validate(dto: ConfigureCheckDto): void {
    const parts = dto.cron.trim().split(/\s+/);
    if (parts.length !== 5) {
      throw new CanaryError(
        "invalid-cron",
        `Cron must have exactly 5 fields, got ${parts.length}: "${dto.cron}"`,
        400,
      );
    }
    const fieldPattern = /^(\*|\d+(-\d+)?(\/\d+)?|\*\/\d+)(,(\*|\d+(-\d+)?(\/\d+)?|\*\/\d+))*$/;
    for (const part of parts) {
      if (!fieldPattern.test(part)) {
        throw new CanaryError("invalid-cron", `Invalid cron field: "${part}" in "${dto.cron}"`, 400);
      }
    }
  }

  static fromInput(dto: ScheduleInputDto): Schedule {
    const { frequency, timeOfDay, daysOfWeek } = dto;

    if (frequency === "hourly") {
      return new Schedule("0 * * * *");
    }

    if (frequency === "once" || frequency === "daily") {
      const { hour, minute } = parseTime(timeOfDay);
      const days = parseDays(daysOfWeek);
      return new Schedule(`${minute} ${hour} * * ${days}`);
    }

    throw new CanaryError("invalid-frequency", `Unknown frequency: "${frequency}" — expected once, hourly, or daily`, 400);
  }

  toCron(): ScheduleDto {
    return { cron: this.cronStr };
  }
}
