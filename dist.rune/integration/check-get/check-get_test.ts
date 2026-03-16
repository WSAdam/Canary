import { getCheckCore } from "./check-get.ts";
import { assertEquals, assertThrows } from "@std/assert";

Deno.test("check get happy path", () => {
  // const result = getCheckCore(/* TODO: provide test inputs */);
  // assertEquals(result.someField, expectedValue);
  throw new Error("Test not implemented");
});

Deno.test("check get handles not-found", () => {
  assertThrows(() => getCheckCore(/* TODO: inputs that trigger not-found */), Error);
});

Deno.test("check get handles timed-out", () => {
  assertThrows(() => getCheckCore(/* TODO: inputs that trigger timed-out */), Error);
});