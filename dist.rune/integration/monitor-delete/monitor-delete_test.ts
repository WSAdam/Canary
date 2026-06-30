import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { deleteMonitor, MONITOR_RUN_PREFIXES, MONITOR_SCOPED_KEYS } from "./monitor-delete.ts";
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

Deno.test("deleteMonitor - removes the monitor and every scoped row; leaves named secrets intact", async () => {
  const m = await createMonitor({ name: uniq("chk"), description: "" });
  const id = m.monitorId;
  // Seed every scoped row a real monitor accumulates (single source of truth).
  for (const key of MONITOR_SCOPED_KEYS(id)) await kv.set(key, { seeded: true });
  const rr = RunResult.build(id, 0, false, m.name, "boom");
  await rr.save(rr.toDto());
  assert((await countPrefix(["run", id])) > 0);
  // An unrelated named secret that must SURVIVE (deletion is scoped by monitorId,
  // not a blanket "secret" prefix wipe).
  const secretKey = uniq("SK");
  await kv.set(["secret", secretKey], { hash: "keep" });

  await deleteMonitor({ monitorId: id });

  await assertRejects(() => getMonitor({ monitorId: id }), CanaryError, "not found");
  for (const key of MONITOR_SCOPED_KEYS(id)) assertEquals((await kv.get(key)).value, null);
  for (const prefix of MONITOR_RUN_PREFIXES(id)) assertEquals(await countPrefix(prefix), 0);
  assertEquals((await kv.get(["monitor_name", m.name])).value, null);
  assertEquals((await kv.get(["secret", secretKey])).value !== null, true); // preserved

  await kv.delete(["secret", secretKey]); // cleanup
});

Deno.test("deleteMonitor - removes a relay monitor's config too (delegated teardown)", async () => {
  const { monitorId } = await createRelayMonitor({
    name: uniq("relay"),
    numbers: ["18432222986"],
    token: "a-long-enough-relay-token",
  });
  assert((await kv.get(["relay", monitorId])).value !== null, "relay config should exist");

  await deleteMonitor({ monitorId });

  await assertRejects(() => getMonitor({ monitorId }), CanaryError, "not found");
  assertEquals((await kv.get(["relay", monitorId])).value, null); // relay config swept
});

Deno.test("deleteMonitor - unknown monitorId is 404", async () => {
  await assertRejects(() => deleteMonitor({ monitorId: crypto.randomUUID() }), CanaryError, "not found");
});
