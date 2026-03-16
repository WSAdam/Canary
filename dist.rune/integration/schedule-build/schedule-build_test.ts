import { buildScheduleCore } from "./schedule-build.ts";
import { assertEquals, assertThrows } from "@std/assert";

Deno.test("schedule build happy path", () => {
  // const result = buildScheduleCore(/* TODO: provide test inputs */);
  // assertEquals(result.someField, expectedValue);
  throw new Error("Test not implemented");
});

Deno.test("schedule build handles invalid-time", () => {
  assertThrows(() => buildScheduleCore(/* TODO: inputs that trigger invalid-time */), Error);
});

Deno.test("schedule build handles invalid-frequency", () => {
  assertThrows(() => buildScheduleCore(/* TODO: inputs that trigger invalid-frequency */), Error);
});