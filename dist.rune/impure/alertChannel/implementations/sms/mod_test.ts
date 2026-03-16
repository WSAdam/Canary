import { Sms } from "./mod.ts";
import { assertEquals, assertRejects } from "@std/assert";

Deno.test("Sms send happy path", async () => {
  // const instance = new Sms();
  // const result = await instance.send(/* TODO: test inputs */);
  // assertEquals(result, expectedValue);
  throw new Error("Test not implemented");
});

Deno.test("Sms send handles send-failed", async () => {
  // const instance = new Sms();
  await assertRejects(() => instance.send(/* inputs that trigger send-failed */), Error);
});

Deno.test("Sms send handles timed-out", async () => {
  // const instance = new Sms();
  await assertRejects(() => instance.send(/* inputs that trigger timed-out */), Error);
});