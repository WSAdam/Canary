import { assertEquals, assertThrows } from "jsr:@std/assert";
import { Comparator } from "./comparator.ts";
import type { CheckDto } from "../../dto/check-dto.ts";

const base: CheckDto = {
  monitorId: "test",
  url: "https://example.com",
  method: "GET",
  headers: {},
  expression: "value",
  comparatorOp: "gt",
  threshold: 10,
  cron: "0 * * * *",
  notifyOnRecover: false,
};

Deno.test("Comparator.evaluate - gt pass", () => {
  assertEquals(Comparator.evaluate({ ...base, comparatorOp: "gt", threshold: 10 }, 11), true);
});

Deno.test("Comparator.evaluate - gt fail", () => {
  assertEquals(Comparator.evaluate({ ...base, comparatorOp: "gt", threshold: 10 }, 9), false);
});

Deno.test("Comparator.evaluate - lt pass", () => {
  assertEquals(Comparator.evaluate({ ...base, comparatorOp: "lt", threshold: 10 }, 5), true);
});

Deno.test("Comparator.evaluate - lte pass on equal", () => {
  assertEquals(Comparator.evaluate({ ...base, comparatorOp: "lte", threshold: 10 }, 10), true);
});

Deno.test("Comparator.evaluate - gte pass on equal", () => {
  assertEquals(Comparator.evaluate({ ...base, comparatorOp: "gte", threshold: 10 }, 10), true);
});

Deno.test("Comparator.evaluate - eq pass", () => {
  assertEquals(Comparator.evaluate({ ...base, comparatorOp: "eq", threshold: 42 }, 42), true);
});

Deno.test("Comparator.evaluate - eq fail", () => {
  assertEquals(Comparator.evaluate({ ...base, comparatorOp: "eq", threshold: 42 }, 43), false);
});

Deno.test("Comparator.evaluate - throws on unknown op", () => {
  assertThrows(
    () => Comparator.evaluate({ ...base, comparatorOp: "invalid" }, 10),
    Error,
    "Unknown comparatorOp",
  );
});
