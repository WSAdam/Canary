import { assertEquals } from "jsr:@std/assert";
import { purgeRelayMonitorKeys } from "./purgeRelayMonitorKeys.ts";
import { kv } from "../../impure/_kv.ts";

const uid = () => crypto.randomUUID();

// Locks the best-effort contract relay-create's rollback relies on: one failing
// kv.delete must NOT reject the call or skip the remaining deletes.
Deno.test("purgeRelayMonitorKeys - a failing delete is swallowed; the rest still run", async () => {
  const monitorId = uid();
  const name = `purge-${monitorId.slice(0, 8)}`;
  // Seed the three keys so we can verify which survive.
  await kv.set(["relay", monitorId], { numbers: ["18432222986"], tokenHash: "x", createdAt: "t" });
  await kv.set(["monitor_name", name], monitorId);
  await kv.set(["monitor", monitorId], { monitorId, name, description: "", type: "relay" });

  // Make the relay-config delete throw; the other two must still happen.
  const orig = kv.delete.bind(kv);
  (kv as { delete: unknown }).delete = (key: Deno.KvKey) => {
    if (key[0] === "relay") throw new Error("boom");
    return orig(key);
  };
  try {
    await purgeRelayMonitorKeys(monitorId, name); // resolves, does not reject
  } finally {
    (kv as { delete: unknown }).delete = orig;
  }

  // The throwing key survives; the other two were deleted despite the failure.
  assertEquals((await kv.get(["relay", monitorId])).value !== null, true);
  assertEquals((await kv.get(["monitor_name", name])).value, null);
  assertEquals((await kv.get(["monitor", monitorId])).value, null);

  await kv.delete(["relay", monitorId]); // cleanup the survivor
});
