import { listMonitorCore } from "./monitor-list.ts";
import { assertEquals, assertThrows } from "@std/assert";

Deno.test("monitor list happy path", () => {
  // const result = listMonitorCore(/* TODO: provide test inputs */);
  // assertEquals(result.someField, expectedValue);
  throw new Error("Test not implemented");
});

Deno.test("monitor list handles timed-out", () => {
  assertThrows(() => listMonitorCore(/* TODO: inputs that trigger timed-out */), Error);
});