import { assertEquals, assertThrows } from "jsr:@std/assert";
import { Schedule } from "./schedule.ts";
import { CanaryError } from "../../dto/_shared.ts";
import type { ConfigureCheckDto } from "../../dto/configure-check-dto.ts";

const baseCheck: ConfigureCheckDto = {
  monitorId: "test",
  url: "https://example.com",
  method: "GET",
  headers: {},
  expression: "value",
  comparatorOp: "gt",
  threshold: 10,
  cron: "0 16 * * 1-5",
  notifyOnRecover: false,
};

Deno.test("Schedule.validate - valid 5-field cron passes", () => {
  Schedule.validate({ ...baseCheck, cron: "0 16 * * 1-5" });
});

Deno.test("Schedule.validate - throws on wrong field count", () => {
  assertThrows(
    () => Schedule.validate({ ...baseCheck, cron: "0 16 *" }),
    Error,
    "5 fields",
  );
});

Deno.test("Schedule.validate - throws on invalid field", () => {
  assertThrows(
    () => Schedule.validate({ ...baseCheck, cron: "abc 16 * * *" }),
    Error,
    "Invalid cron field",
  );
});

Deno.test("Schedule.validate - weekday 7 (Sunday) is accepted", () => {
  Schedule.validate({ ...baseCheck, cron: "0 9 * * 7" });
});

Deno.test("Schedule.validate - throws on out-of-range weekday 8", () => {
  assertThrows(
    () => Schedule.validate({ ...baseCheck, cron: "0 9 * * 8" }),
    Error,
    "out of range",
  );
});

Deno.test("Schedule.validate - throws on out-of-range minute 60", () => {
  assertThrows(
    () => Schedule.validate({ ...baseCheck, cron: "60 9 * * *" }),
    Error,
    "out of range",
  );
});

Deno.test("Schedule.validate - throws on out-of-range month 13", () => {
  assertThrows(
    () => Schedule.validate({ ...baseCheck, cron: "0 9 1 13 *" }),
    Error,
    "out of range",
  );
});

Deno.test("Schedule.validate - throws on zero step */0", () => {
  assertThrows(
    () => Schedule.validate({ ...baseCheck, cron: "*/0 * * * *" }),
    Error,
    "step must be >= 1",
  );
});

Deno.test("Schedule.fromInput - daily at 4:00 PM on weekdays", () => {
  const s = Schedule.fromInput({ timeOfDay: "4:00 PM", daysOfWeek: "weekdays", frequency: "daily" });
  assertEquals(s.toCron(), { cron: "0 16 * * 1-5" });
});

Deno.test("Schedule.fromInput - hourly ignores time/days", () => {
  const s = Schedule.fromInput({ timeOfDay: "4:00 PM", daysOfWeek: "weekdays", frequency: "hourly" });
  assertEquals(s.toCron(), { cron: "0 * * * *" });
});

Deno.test("Schedule.fromInput - 'once' is rejected (cron can't express one-shot)", () => {
  const err = assertThrows(
    () => Schedule.fromInput({ timeOfDay: "9:30 AM", daysOfWeek: "daily", frequency: "once" }),
    CanaryError,
  );
  assertEquals((err as CanaryError).fault, "invalid-frequency");
});

Deno.test("Schedule.fromInput - 12:00 PM (noon)", () => {
  const s = Schedule.fromInput({ timeOfDay: "12:00 PM", daysOfWeek: "daily", frequency: "daily" });
  assertEquals(s.toCron(), { cron: "0 12 * * *" });
});

Deno.test("Schedule.fromInput - 12:00 AM (midnight)", () => {
  const s = Schedule.fromInput({ timeOfDay: "12:00 AM", daysOfWeek: "daily", frequency: "daily" });
  assertEquals(s.toCron(), { cron: "0 0 * * *" });
});

Deno.test("Schedule.fromInput - throws on invalid time", () => {
  const err = assertThrows(
    () => Schedule.fromInput({ timeOfDay: "25:00 PM", daysOfWeek: "daily", frequency: "daily" }),
    CanaryError,
  );
  assertEquals(err.fault, "invalid-time");
});

Deno.test("Schedule.fromInput - throws on invalid frequency", () => {
  const err = assertThrows(
    () => Schedule.fromInput({ timeOfDay: "9:00 AM", daysOfWeek: "daily", frequency: "monthly" }),
    CanaryError,
  );
  assertEquals(err.fault, "invalid-frequency");
});
