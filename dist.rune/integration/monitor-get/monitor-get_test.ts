import { getMonitorCore } from "./monitor-get.ts";
import { assertEquals, assertThrows } from "@std/assert";

Deno.test("monitor get happy path", () => {
  // const result = getMonitorCore(/* TODO: provide test inputs */);
  // assertEquals(result.someField, expectedValue);
  throw new Error("Test not implemented");
});

Deno.test("monitor get handles not-found", () => {
  assertThrows(() => getMonitorCore(/* TODO: inputs that trigger not-found */), Error);
});

Deno.test("monitor get handles timed-out", () => {
  assertThrows(() => getMonitorCore(/* TODO: inputs that trigger timed-out */), Error);
});