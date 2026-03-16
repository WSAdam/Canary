import { BaseAlertChannel } from "./mod.ts";
import { assertEquals } from "@std/assert";

Deno.test("BaseAlertChannel exists", () => {
  assertEquals(typeof BaseAlertChannel, "function");
});