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

// Reject out-of-range field values (e.g. weekday 8, month 13, minute 60) and
// zero steps (*/0) that the structural regex alone would let through and that
// would otherwise silently never fire.
function validateFieldRange(field: string, lo: number, hi: number, cron: string): void {
  for (const token of field.split(",")) {
    const [rangePart, stepPart] = token.split("/");
    if (stepPart !== undefined && !(parseInt(stepPart, 10) >= 1)) {
      throw new CanaryError("invalid-cron", `Cron step must be >= 1 in "${cron}"`, 400);
    }
    if (rangePart === "*") continue;
    for (const n of rangePart.split("-")) {
      const v = parseInt(n, 10);
      if (v < lo || v > hi) {
        throw new CanaryError("invalid-cron", `Cron value ${v} out of range ${lo}-${hi} in "${cron}"`, 400);
      }
    }
  }
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
    // minute, hour, day-of-month, month, day-of-week (7 = Sunday, like 0)
    const ranges: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
    parts.forEach((part, i) => {
      if (!fieldPattern.test(part)) {
        throw new CanaryError("invalid-cron", `Invalid cron field: "${part}" in "${dto.cron}"`, 400);
      }
      validateFieldRange(part, ranges[i][0], ranges[i][1], dto.cron);
    });
  }

  static fromInput(dto: ScheduleInputDto): Schedule {
    const { frequency, timeOfDay, daysOfWeek } = dto;

    if (frequency === "hourly") {
      return new Schedule("0 * * * *");
    }

    if (frequency === "daily") {
      const { hour, minute } = parseTime(timeOfDay);
      const days = parseDays(daysOfWeek);
      return new Schedule(`${minute} ${hour} * * ${days}`);
    }

    throw new CanaryError("invalid-frequency", `Unknown frequency: "${frequency}" — expected hourly or daily`, 400);
  }

  toCron(): ScheduleDto {
    return { cron: this.cronStr };
  }
}
