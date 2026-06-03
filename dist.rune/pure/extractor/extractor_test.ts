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

Deno.test("Extractor.applyCaptures - serializes objects/arrays as JSON, not [object Object]", () => {
  const payload = '{"totalErrors": 1, "errors": [{"code": "X"}], "meta": {"ok": false}}';
  const result = Extractor.applyCaptures(
    { totalErrors: "totalErrors", errors: "errors", meta: "meta" },
    payload,
  );
  assertEquals(result.totalErrors, "1");
  assertEquals(result.errors, '[{"code":"X"}]');
  assertEquals(result.meta, '{"ok":false}');
});

Deno.test("Extractor.applyCaptures - primitives and missing paths", () => {
  const payload = '{"name": "autobottom", "flag": true, "ratio": 0.5}';
  const result = Extractor.applyCaptures(
    { name: "name", flag: "flag", ratio: "ratio", missing: "nope.gone" },
    payload,
  );
  assertEquals(result.name, "autobottom");
  assertEquals(result.flag, "true");
  assertEquals(result.ratio, "0.5");
  assertEquals(result.missing, "");
});

Deno.test("Extractor.applyCaptures - returns empty object on invalid JSON", () => {
  assertEquals(Extractor.applyCaptures({ a: "a" }, "not json"), {});
});
