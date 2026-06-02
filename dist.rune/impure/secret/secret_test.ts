import { assertEquals, assertRejects } from "jsr:@std/assert";
import { Secret } from "./secret.ts";
import { CanaryError } from "../../dto/_shared.ts";

// Exercises the real (local) Deno KV store. Keys are unique per run so repeated
// runs don't collide.
Deno.test("Secret - upsert, resolve, list, delete roundtrip", async () => {
  const secret = new Secret();
  const key = "TEST_" + crypto.randomUUID().replace(/-/g, "_");

  await secret.upsert({ secretKey: key, secretValue: "s3cr3t-value" });

  // resolve returns the raw value (server-side only)
  assertEquals(await secret.resolve(key), "s3cr3t-value");

  // list returns key names only (never values)
  const listed = await secret.list();
  const entry = listed.secrets.find((s) => s.secretKey === key);
  assertEquals(entry, { secretKey: key });

  await secret.delete(key);
  await assertRejects(() => secret.resolve(key), CanaryError, "not found");
});

Deno.test("Secret.resolve - throws not-found for unknown key", async () => {
  const secret = new Secret();
  await assertRejects(
    () => secret.resolve("DEFINITELY_MISSING_" + crypto.randomUUID().replace(/-/g, "")),
    CanaryError,
    "not found",
  );
});
