import { assertEquals, assertThrows } from "jsr:@std/assert";
import { buildSchedule } from "./schedule-build.ts";
import { CanaryError } from "../../dto/_shared.ts";

Deno.test("buildSchedule - daily at 4:00 PM on weekdays", () => {
  const result = buildSchedule({ frequency: "daily", timeOfDay: "4:00 PM", daysOfWeek: "weekdays" });
  assertEquals(result, { cron: "0 16 * * 1-5" });
});

Deno.test("buildSchedule - hourly", () => {
  const result = buildSchedule({ frequency: "hourly", timeOfDay: "4:00 PM", daysOfWeek: "weekdays" });
  assertEquals(result, { cron: "0 * * * *" });
});

Deno.test("buildSchedule - throws invalid-time", () => {
  const err = assertThrows(
    () => buildSchedule({ frequency: "daily", timeOfDay: "25:00 PM", daysOfWeek: "daily" }),
    CanaryError,
  );
  assertEquals((err as CanaryError).fault, "invalid-time");
});

Deno.test("buildSchedule - throws invalid-frequency (incl. removed 'once')", () => {
  const err = assertThrows(
    () => buildSchedule({ frequency: "once", timeOfDay: "9:00 AM", daysOfWeek: "daily" }),
    CanaryError,
  );
  assertEquals((err as CanaryError).fault, "invalid-frequency");
});
