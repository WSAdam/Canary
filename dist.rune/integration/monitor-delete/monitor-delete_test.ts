import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { deleteMonitor, monitorRunPrefixes, monitorScopedKeys } from "./monitor-delete.ts";
import { createMonitor } from "../monitor-create/monitor-create.ts";
import { createRelayMonitor } from "../relay-create/relay-create.ts";
import { getMonitor } from "../monitor-get/monitor-get.ts";
import { RunResult } from "../../impure/runResult/runResult.ts";
import { kv } from "../../impure/_kv.ts";
import { CanaryError } from "../../dto/_shared.ts";

const uniq = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;

async function countPrefix(prefix: Deno.KvKey): Promise<number> {
  let n = 0;
  for await (const _ of kv.list({ prefix }, { consistency: "strong" })) n++;
  return n;
}

// Seed every scoped row + a run so a delete assertion proves something (a fresh
// monitor accumulates none of these, so asserting them gone without seeding
// would be vacuously true).
async function seedScopedRows(monitorId: string, monitorName: string): Promise<void> {
  for (const key of monitorScopedKeys(monitorId)) await kv.set(key, { seeded: true });
  const rr = RunResult.build(monitorId, 0, false, monitorName, "boom");
  await rr.save(rr.toDto());
}

async function assertScopedRowsGone(monitorId: string): Promise<void> {
  for (const key of monitorScopedKeys(monitorId)) assertEquals((await kv.get(key)).value, null);
  for (const prefix of monitorRunPrefixes(monitorId)) assertEquals(await countPrefix(prefix), 0);
}

Deno.test("deleteMonitor - removes the monitor and every scoped row; leaves named secrets intact", async () => {
  const m = await createMonitor({ name: uniq("chk"), description: "" });
  const id = m.monitorId;
  await seedScopedRows(id, m.name);
  assert((await countPrefix(["run", id])) > 0);
  // An unrelated named secret that must SURVIVE (deletion is scoped by monitorId,
  // not a blanket "secret" prefix wipe).
  const secretKey = uniq("SK");
  await kv.set(["secret", secretKey], { hash: "keep" });

  await deleteMonitor({ monitorId: id });

  await assertRejects(() => getMonitor({ monitorId: id }), CanaryError, "not found");
  await assertScopedRowsGone(id);
  assertEquals((await kv.get(["monitor_name", m.name])).value, null);
  assertEquals((await kv.get(["secret", secretKey])).value !== null, true); // preserved

  await kv.delete(["secret", secretKey]); // cleanup
});

Deno.test("deleteMonitor - sweeps a relay monitor's scoped/run rows AND its relay config (delegated teardown)", async () => {
  const { monitorId, name } = await createRelayMonitor({
    name: uniq("relay"),
    numbers: ["18432222986"],
    token: "a-long-enough-relay-token",
  });
  await seedScopedRows(monitorId, name);
  assert((await kv.get(["relay", monitorId])).value !== null, "relay config should exist");

  await deleteMonitor({ monitorId });

  await assertRejects(() => getMonitor({ monitorId }), CanaryError, "not found");
  await assertScopedRowsGone(monitorId); // generic scoped/run sweep ran on the relay path
  assertEquals((await kv.get(["relay", monitorId])).value, null); // delegated purgeRelayMonitorKeys
});

Deno.test("deleteMonitor - unknown monitorId is 404", async () => {
  await assertRejects(() => deleteMonitor({ monitorId: crypto.randomUUID() }), CanaryError, "not found");
});
