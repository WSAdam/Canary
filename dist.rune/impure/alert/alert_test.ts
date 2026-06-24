import { assertEquals, assertRejects } from "jsr:@std/assert";
import { Alert } from "./alert.ts";
import { CanaryError } from "../../dto/_shared.ts";

// Exercises the real (local) Deno KV store. Monitor ids are unique per run so
// repeated runs don't collide.
Deno.test("Alert - upsert, get, delete roundtrip", async () => {
  const alert = new Alert();
  const monitorId = "TEST_" + crypto.randomUUID();

  await alert.upsert({
    monitorId,
    recipients: [{ channel: "email", address: "ops@example.com" }],
  });

  const got = await alert.get(monitorId);
  assertEquals(got.monitorId, monitorId);
  assertEquals(got.recipients.length, 1);

  await alert.delete(monitorId);
  await assertRejects(() => alert.get(monitorId), CanaryError, "not found");
});

Deno.test("Alert.delete - is idempotent for an unconfigured monitor", async () => {
  const alert = new Alert();
  const monitorId = "MISSING_" + crypto.randomUUID();
  // Deleting a monitor that never had an alert must not throw.
  await alert.delete(monitorId);
});
