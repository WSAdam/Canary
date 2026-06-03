import { assertEquals } from "jsr:@std/assert";
import { redactHeaders, redactSecrets, resolveCheckSecrets } from "./runner-execute.ts";
import type { CheckDto } from "../../dto/check-dto.ts";

const baseCheck: CheckDto = {
  monitorId: "test",
  url: "https://example.com/health",
  method: "GET",
  headers: {},
  expression: "value",
  comparatorOp: "gt",
  threshold: 10,
  cron: "0 * * * *",
  notifyOnRecover: false,
};

Deno.test("redactSecrets - replaces every occurrence of each secret value", () => {
  const out = redactSecrets("Failed to reach https://x?key=abc123 (abc123)", ["abc123"]);
  assertEquals(out, "Failed to reach https://x?key=*** (***)");
});

Deno.test("redactSecrets - no-op when no secret values", () => {
  assertEquals(redactSecrets("HTTP 500 from https://x", []), "HTTP 500 from https://x");
});

Deno.test("redactHeaders - masks sensitive header values, leaves others", () => {
  const out = redactHeaders({
    Authorization: "Bearer secrettoken",
    "X-Api-Key": "abc123",
    "Content-Type": "application/json",
  });
  assertEquals(out, {
    Authorization: "***",
    "X-Api-Key": "***",
    "Content-Type": "application/json",
  });
});

Deno.test("resolveCheckSecrets - returns check unchanged and touches no KV when no {{tokens}}", async () => {
  const { check, secretValues } = await resolveCheckSecrets(baseCheck);
  assertEquals(check, baseCheck);
  assertEquals(secretValues, []);
});
