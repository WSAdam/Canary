import { BaseSource } from "./mod.ts";
import { assertEquals } from "@std/assert";

Deno.test("BaseSource exists", () => {
  assertEquals(typeof BaseSource, "function");
});