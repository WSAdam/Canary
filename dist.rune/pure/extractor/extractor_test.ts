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

Deno.test("Extractor.apply - throws the type-aware single-path message (wrong type)", () => {
  // Pins the original single-path message (the candidates.length===1 && !sentinel
  // branch), our backward-compat guarantee for plain dot-path checks.
  assertThrows(
    () => Extractor.apply(base, { payload: '{"value": "hello"}' }),
    Error,
    'Expression "value" resolved to string, expected number',
  );
});

Deno.test("Extractor.apply - throws the type-aware single-path message (missing path)", () => {
  assertThrows(
    () => Extractor.apply(base, { payload: '{"other": 1}' }),
    Error,
    'Expression "value" resolved to undefined, expected number',
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

// ── $errors: robust error-count resolution regardless of the producer's field name ──

const errExpr: CheckDto = { ...base, expression: "$errors", comparatorOp: "lte", threshold: 0 };

Deno.test("$errors - the incident: reads totalErrors from the canary contract response", () => {
  // Exactly the sms-bot response that broke the "unrecoveredErrors" check.
  const payload = '{"ok":true,"timezone":"America/New_York","date":"2026-06-30","totalErrors":0,"errors":[]}';
  assertEquals(Extractor.apply(errExpr, { payload }), 0);
});

Deno.test("$errors - reads unrecoveredErrors when totalErrors is absent", () => {
  assertEquals(Extractor.apply(errExpr, { payload: '{"unrecoveredErrors": 3, "errors": []}' }), 3);
});

Deno.test("$errors - prefers totalErrors when several error counts are present", () => {
  assertEquals(Extractor.apply(errExpr, { payload: '{"unrecoveredErrors": 3, "totalErrors": 7}' }), 7);
});

Deno.test("$errors - falls back to the errors[] array length when there's no numeric count", () => {
  assertEquals(Extractor.apply(errExpr, { payload: '{"errors": [{"m":"a"},{"m":"b"}]}' }), 2);
});

Deno.test("$errors - guarded fuzzy match on a novel error-count field name", () => {
  assertEquals(Extractor.apply(errExpr, { payload: '{"outstandingErrors": 4}' }), 4);
});

Deno.test("$errors - does NOT mistake a rate/threshold field for a count", () => {
  // errorRate must not be read as the count — that would let real errors slip by.
  assertThrows(
    () => Extractor.apply(errExpr, { payload: '{"errorRate": 0.5, "errorThreshold": 10}' }),
    Error,
    "did not resolve to a number",
  );
});

Deno.test("$errors - finds the count nested under a wrapper object", () => {
  assertEquals(Extractor.apply(errExpr, { payload: '{"data": {"totalErrors": 5}}' }), 5);
});

Deno.test("$errors - is case-insensitive on the sentinel", () => {
  assertEquals(Extractor.apply({ ...errExpr, expression: "$errorCount" }, { payload: '{"totalErrors": 9}' }), 9);
});

Deno.test("expression - pipe-separated fallbacks return the first that resolves to a number", () => {
  const dto: CheckDto = { ...base, expression: "totalErrors|unrecoveredErrors" };
  assertEquals(Extractor.apply(dto, { payload: '{"unrecoveredErrors": 2}' }), 2); // first path missing → second wins
  assertEquals(Extractor.apply(dto, { payload: '{"totalErrors": 8, "unrecoveredErrors": 2}' }), 8); // first wins
});

Deno.test("expression - multi-candidate all-miss throws the plain (non-sentinel) message", () => {
  // The only path to the generic message with NO "looked for an error count"
  // suffix: >1 candidate, none resolves, usedSentinel=false.
  const dto: CheckDto = { ...base, expression: "missingA|missingB" };
  const err = assertThrows(
    () => Extractor.apply(dto, { payload: '{"other": 1}' }),
    Error,
    "did not resolve to a number",
  ) as Error;
  assertEquals(err.message.includes("looked for an error count"), false);
});

Deno.test("$errors - a shallower count wins over one nested under an earlier sibling (BFS)", () => {
  // Regression for the DFS bug: pre-order recursion recorded a.deep.totalErrors (depth 2)
  // before b.totalErrors (depth 1); breadth-first must prefer the shallower depth-1 value.
  const payload = '{"a": {"deep": {"totalErrors": 1}}, "b": {"totalErrors": 2}}';
  assertEquals(Extractor.apply(errExpr, { payload }), 2);
});

Deno.test("$errors - a pathologically deep payload doesn't overflow the stack", () => {
  // ~6000 deep — beyond the native recursion limit the old DFS would hit. The
  // iterative queue resolves the top-level count without a RangeError.
  const depth = 6000;
  const payload = '{"totalErrors":0,"n":' + '{"n":'.repeat(depth) + "null" + "}".repeat(depth) + "}";
  assertEquals(Extractor.apply(errExpr, { payload }), 0);
});
