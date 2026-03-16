import { assertEquals, assertThrows } from "jsr:@std/assert";
import { Extractor } from "./extractor.ts";
import type { CheckDto } from "../../dto/check-dto.ts";
import type { ResponseDto } from "../../dto/response-dto.ts";

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

Deno.test("Extractor.apply - top-level key", () => {
  const response: ResponseDto = { payload: '{"value": 42}' };
  assertEquals(Extractor.apply(base, response), 42);
});

Deno.test("Extractor.apply - nested path", () => {
  const dto: CheckDto = { ...base, expression: "data.price" };
  const response: ResponseDto = { payload: '{"data": {"price": 9.99}}' };
  assertEquals(Extractor.apply(dto, response), 9.99);
});

Deno.test("Extractor.apply - throws on invalid JSON", () => {
  assertThrows(
    () => Extractor.apply(base, { payload: "not json" }),
    Error,
    "not valid JSON",
  );
});

Deno.test("Extractor.apply - throws when path does not resolve to number", () => {
  assertThrows(
    () => Extractor.apply(base, { payload: '{"value": "hello"}' }),
    Error,
    "expected number",
  );
});

Deno.test("Extractor.apply - throws when path is missing", () => {
  assertThrows(
    () => Extractor.apply(base, { payload: '{"other": 1}' }),
    Error,
    "expected number",
  );
});
