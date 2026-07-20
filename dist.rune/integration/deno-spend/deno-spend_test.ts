import { assertEquals } from "jsr:@std/assert";
import { resolveConfig } from "./deno-spend.ts";
import { Secret } from "../../impure/secret/secret.ts";

// The session cookie is refreshed by pasting into the dashboard's secret store
// — no redeploy — so the STORE must win over a stale env var, and the env must
// still work for a setup that never saved a secret.

Deno.test("resolveConfig - the Canary secret store wins over the env", async () => {
  const key = "DD_TEST_CFG_" + crypto.randomUUID().slice(0, 8).replaceAll("-", "_");
  Deno.env.set(key, "stale-env-value");
  try {
    await new Secret().upsert({ secretKey: key, secretValue: "fresh-secret-value" });
    assertEquals(await resolveConfig(key), "fresh-secret-value");
  } finally {
    await new Secret().delete(key);
    Deno.env.delete(key);
  }
});

Deno.test("resolveConfig - falls back to the env when no secret is stored", async () => {
  const key = "DD_TEST_CFG_" + crypto.randomUUID().slice(0, 8).replaceAll("-", "_");
  Deno.env.set(key, "  env-value  ");
  try {
    assertEquals(await resolveConfig(key), "env-value", "env value is used and trimmed");
  } finally {
    Deno.env.delete(key);
  }
});

Deno.test("resolveConfig - a blank secret does not mask a real env value", async () => {
  const key = "DD_TEST_CFG_" + crypto.randomUUID().slice(0, 8).replaceAll("-", "_");
  Deno.env.set(key, "env-value");
  try {
    // A secret saved as whitespace (an accidental paste) must not win.
    await new Secret().upsert({ secretKey: key, secretValue: "   " });
    assertEquals(await resolveConfig(key), "env-value");
  } finally {
    await new Secret().delete(key);
    Deno.env.delete(key);
  }
});

Deno.test("resolveConfig - undefined when configured nowhere", async () => {
  assertEquals(await resolveConfig("DD_TEST_CFG_MISSING_" + crypto.randomUUID().slice(0, 8)), undefined);
});
