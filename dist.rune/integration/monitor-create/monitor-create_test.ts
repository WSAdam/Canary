import { createMonitorCore } from "./monitor-create.ts";
import { assertEquals, assertThrows } from "@std/assert";

Deno.test("monitor create happy path", () => {
  // const result = createMonitorCore(/* TODO: provide test inputs */);
  // assertEquals(result.someField, expectedValue);
  throw new Error("Test not implemented");
});

Deno.test("monitor create handles duplicate-name", () => {
  assertThrows(() => createMonitorCore(/* TODO: inputs that trigger duplicate-name */), Error);
});

Deno.test("monitor create handles timed-out", () => {
  assertThrows(() => createMonitorCore(/* TODO: inputs that trigger timed-out */), Error);
});