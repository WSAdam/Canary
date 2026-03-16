import { getAlertCore } from "./alert-get.ts";
import { assertEquals, assertThrows } from "@std/assert";

Deno.test("alert get happy path", () => {
  // const result = getAlertCore(/* TODO: provide test inputs */);
  // assertEquals(result.someField, expectedValue);
  throw new Error("Test not implemented");
});

Deno.test("alert get handles not-found", () => {
  assertThrows(() => getAlertCore(/* TODO: inputs that trigger not-found */), Error);
});

Deno.test("alert get handles timed-out", () => {
  assertThrows(() => getAlertCore(/* TODO: inputs that trigger timed-out */), Error);
});