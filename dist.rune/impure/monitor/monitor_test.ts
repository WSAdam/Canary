import { assertEquals } from "jsr:@std/assert";
import { Monitor } from "./monitor.ts";
import { kv } from "../_kv.ts";

const uniq = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;

// Records written before relays existed have no `type` field. get/list/update
// must normalize them to "check" so legacy monitors keep behaving as checks.
// Write a raw legacy record directly (bypassing insert, which now always sets
// type) to exercise the `?? "check"` branches.
Deno.test("Monitor - legacy record (no type) normalizes to 'check' on get/list/update", async () => {
  const monitorId = crypto.randomUUID();
  const name = uniq("legacy");
  await kv.set(["monitor", monitorId], { monitorId, name, description: "d" }); // no `type`
  await kv.set(["monitor_name", name], monitorId);
  const monitor = new Monitor();
  try {
    assertEquals((await monitor.get(monitorId)).type, "check");

    const listed = (await monitor.list()).monitors.find((m) => m.monitorId === monitorId);
    assertEquals(listed?.type, "check");

    // A description-only update rewrites the record — it must now carry type.
    await monitor.update({ monitorId, name, description: "after" });
    const raw = await kv.get<{ type?: string }>(["monitor", monitorId]);
    assertEquals(raw.value?.type, "check");
  } finally {
    await kv.delete(["monitor", monitorId]);
    await kv.delete(["monitor_name", name]);
  }
});
