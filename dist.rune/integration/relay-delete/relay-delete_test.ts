import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { deleteRelay } from "./relay-delete.ts";
import { createRelayMonitor } from "../relay-create/relay-create.ts";
import { fireRelay } from "../relay-fire/relay-fire.ts";
import { createMonitor } from "../monitor-create/monitor-create.ts";
import { getMonitor } from "../monitor-get/monitor-get.ts";
import { RunResult } from "../../impure/runResult/runResult.ts";
import { kv } from "../../impure/_kv.ts";
import { CanaryError } from "../../dto/_shared.ts";

const uniq = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;
const TOKEN = "a-long-enough-relay-token";

async function countPrefix(prefix: Deno.KvKey): Promise<number> {
  let n = 0;
  for await (const _ of kv.list({ prefix }, { consistency: "strong" })) n++;
  return n;
}

Deno.test("deleteRelay - refuses to delete a check monitor (type guard)", async () => {
  const m = await createMonitor({ name: uniq("chk"), description: "" }); // type "check"
  await assertRejects(() => deleteRelay({ monitorId: m.monitorId }), CanaryError, "is not a relay");
  // The check monitor must survive a rejected delete (no partial teardown).
  assertEquals((await getMonitor({ monitorId: m.monitorId })).monitorId, m.monitorId);
});

Deno.test("deleteRelay - clears the monitor and its run/run_idx history", async () => {
  // Dead SMS endpoint so the fire's dispatch fails fast (no real SMS); the run is
  // still persisted before dispatch, which is what we're testing the sweep on.
  Deno.env.set("ZAPIER_SMS_URL", "http://127.0.0.1:9/dead");
  const { monitorId } = await createRelayMonitor({ name: uniq("relay"), numbers: ["18432222986"], token: TOKEN });
  try {
    await fireRelay({ monitorId, token: TOKEN, payload: { error: "boom" } });
    assert((await RunResult.getLatest(monitorId)) !== null, "run should be persisted before delete");
    assert((await countPrefix(["run", monitorId])) > 0);

    await deleteRelay({ monitorId });

    // Monitor gone, and no orphaned run/run_idx rows left behind.
    await assertRejects(() => getMonitor({ monitorId }), CanaryError, "not found");
    assertEquals(await RunResult.getLatest(monitorId), null);
    assertEquals(await countPrefix(["run", monitorId]), 0);
    assertEquals(await countPrefix(["run_idx", monitorId]), 0);
  } finally {
    Deno.env.delete("ZAPIER_SMS_URL");
  }
});
