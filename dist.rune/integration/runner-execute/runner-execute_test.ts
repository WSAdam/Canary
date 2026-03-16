import { executeRunnerCore } from "./runner-execute.ts";
import { assertEquals, assertThrows } from "@std/assert";

Deno.test("runner execute happy path", () => {
  // const result = executeRunnerCore(/* TODO: provide test inputs */);
  // assertEquals(result.someField, expectedValue);
  throw new Error("Test not implemented");
});

Deno.test("runner execute handles not-found", () => {
  assertThrows(() => executeRunnerCore(/* TODO: inputs that trigger not-found */), Error);
});

Deno.test("runner execute handles timed-out", () => {
  assertThrows(() => executeRunnerCore(/* TODO: inputs that trigger timed-out */), Error);
});

Deno.test("runner execute handles request-failed", () => {
  assertThrows(() => executeRunnerCore(/* TODO: inputs that trigger request-failed */), Error);
});

Deno.test("runner execute handles extraction-failed", () => {
  assertThrows(() => executeRunnerCore(/* TODO: inputs that trigger extraction-failed */), Error);
});

Deno.test("runner execute handles send-failed", () => {
  assertThrows(() => executeRunnerCore(/* TODO: inputs that trigger send-failed */), Error);
});