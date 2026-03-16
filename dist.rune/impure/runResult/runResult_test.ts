import { RunResult } from "./runResult.ts";
import { assertEquals, assertRejects } from "@std/assert";

Deno.test("RunResult build happy path", async () => {
  // const instance = new RunResult(/* TODO: constructor args */);
  // const result = instance.build(/* TODO: provide test inputs */);
  // assertEquals(result, expectedValue);
  throw new Error("Test not implemented");
});

Deno.test("RunResult toDto happy path", async () => {
  // const instance = new RunResult(/* TODO: constructor args */);
  // const result = instance.toDto(/* TODO: provide test inputs */);
  // assertEquals(result, expectedValue);
  throw new Error("Test not implemented");
});

Deno.test("RunResult save happy path", async () => {
  // const instance = new RunResult(/* TODO: constructor args */);
  // const result = await instance.save(/* TODO: provide test inputs */);
  // assertEquals(result, expectedValue);
  throw new Error("Test not implemented");
});

Deno.test("RunResult save throws on timed-out", async () => {
  // const instance = new RunResult(/* TODO: constructor args */);
  await assertRejects(() => instance.save(/* TODO: inputs that trigger timed-out */), Error);
});