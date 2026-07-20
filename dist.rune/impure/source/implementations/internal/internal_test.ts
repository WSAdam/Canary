import { assertEquals, assertThrows } from "jsr:@std/assert";
import { isInternalUrl, parseInternalUrl, SCHEME } from "./mod.ts";
import { Source } from "../../mod.ts";
import type { CheckDto } from "../../../../dto/check-dto.ts";

function check(url: string): CheckDto {
  return {
    monitorId: "m1",
    url,
    method: "GET",
    headers: {},
    expression: "requests",
    comparatorOp: "gte",
    threshold: 0,
    cron: "0 9 * * *",
    notifyOnRecover: false,
    notifyOnSuccess: true,
  } as CheckDto;
}

Deno.test("isInternalUrl - recognises the internal scheme, case/space tolerant", () => {
  assertEquals(isInternalUrl("internal:deno-usage"), true);
  assertEquals(isInternalUrl("  INTERNAL:deno-spend"), true);
  assertEquals(isInternalUrl("https://example.com/api"), false);
  assertEquals(isInternalUrl(""), false);
});

Deno.test("parseInternalUrl - splits producer name from query params", () => {
  const { name, params } = parseInternalUrl("internal:deno-usage?hours=48");
  assertEquals(name, "deno-usage");
  assertEquals(params.get("hours"), "48");
});

Deno.test("parseInternalUrl - tolerates slash-prefixed forms", () => {
  assertEquals(parseInternalUrl("internal:/deno-spend").name, "deno-spend");
  assertEquals(parseInternalUrl("internal://deno-spend").name, "deno-spend");
});

Deno.test("parseInternalUrl - unknown producer fails loud and names the valid ones", () => {
  const err = assertThrows(() => parseInternalUrl("internal:deno-usge")) as Error;
  assertEquals(err.message.includes("deno-usage"), true, "should list the valid producers");
});

Deno.test("parseInternalUrl - rejects a non-internal scheme", () => {
  assertThrows(() => parseInternalUrl("https://example.com"));
});

Deno.test("Source.fromCheck - dispatches internal: away from HTTP", () => {
  // An http check must NOT resolve to the internal source, and vice versa. We
  // assert on the impl's constructor name rather than running either, since
  // both would perform real I/O.
  const internalImpl = (Source.fromCheck(check("internal:deno-usage")) as unknown as { impl: object }).impl;
  const httpImpl = (Source.fromCheck(check("https://example.com/health")) as unknown as { impl: object }).impl;
  assertEquals(internalImpl.constructor.name, "Internal");
  assertEquals(httpImpl.constructor.name, "Http");
});

Deno.test("SCHEME - is the literal used by the check URL form", () => {
  assertEquals(SCHEME, "internal:");
});
