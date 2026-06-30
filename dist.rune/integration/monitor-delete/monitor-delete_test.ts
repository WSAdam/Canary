import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { deleteMonitor } from "./monitor-delete.ts";
import { createMonitor } from "../monitor-create/monitor-create.ts";
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

Deno.test("deleteMonitor - removes the monitor and every scoped row", async () => {
  const m = await createMonitor({ name: uniq("chk"), description: "" });
  const id = m.monitorId;
  // Seed the per-monitor rows a real monitor accumulates.
  await kv.set(["check", id], { monitorId: id });
  await kv.set(["alert", id], { monitorId: id, recipients: [] });
  await kv.set(["webhook_secret", id], { hash: "x", fingerprint: "y", createdAt: "t" });
  await kv.set(["run_corrupt_ack", id], { dismissedAt: "t" });
  const rr = RunResult.build(id, 0, false, m.name, "boom");
  await rr.save(rr.toDto());
  assert((await countPrefix(["run", id])) > 0);

  await deleteMonitor({ monitorId: id });

  await assertRejects(() => getMonitor({ monitorId: id }), CanaryError, "not found");
  assertEquals((await kv.get(["check", id])).value, null);
  assertEquals((await kv.get(["alert", id])).value, null);
  assertEquals((await kv.get(["webhook_secret", id])).value, null);
  assertEquals((await kv.get(["run_corrupt_ack", id])).value, null);
  assertEquals((await kv.get(["monitor_name", m.name])).value, null);
  assertEquals(await countPrefix(["run", id]), 0);
  assertEquals(await countPrefix(["run_idx", id]), 0);
});

Deno.test("deleteMonitor - unknown monitorId is 404", async () => {
  await assertRejects(() => deleteMonitor({ monitorId: crypto.randomUUID() }), CanaryError, "not found");
});
