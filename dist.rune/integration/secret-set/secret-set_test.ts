import { assertEquals, assertRejects } from "jsr:@std/assert";
import { setSecret } from "./secret-set.ts";
import { Secret } from "../../impure/secret/secret.ts";
import { CanaryError } from "../../dto/_shared.ts";

Deno.test("setSecret - rejects a non-string (numeric) secretKey with 400 before it reaches KV", async () => {
  const err = await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => setSecret({ secretKey: 12345 as any, secretValue: "x" }),
    CanaryError,
  );
  assertEquals(err.status, 400);
});

Deno.test("setSecret - rejects a missing secretKey with 400 (not an opaque 500)", async () => {
  const err = await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => setSecret({ secretValue: "x" } as any),
    CanaryError,
  );
  assertEquals(err.status, 400);
});

Deno.test("setSecret - rejects an oversized secretValue with 400", async () => {
  const err = await assertRejects(
    () => setSecret({ secretKey: "BIG_VALUE_KEY", secretValue: "v".repeat(70 * 1024) }),
    CanaryError,
  );
  assertEquals(err.status, 400);
});

Deno.test("setSecret - stores a valid string key/value", async () => {
  const key = "VALID_" + crypto.randomUUID().replace(/-/g, "_");
  const result = await setSecret({ secretKey: key, secretValue: "ok" });
  assertEquals(result.secretKey, key);
  await new Secret().delete(key);
});
