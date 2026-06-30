import { assertEquals } from "jsr:@std/assert";
import { createMonitor } from "./monitor-create.ts";
import { getMonitor } from "../monitor-get/monitor-get.ts";
import type { MonitorType } from "../../dto/monitor-dto.ts";

const uniq = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;

// createMonitor coerces the type so an arbitrary caller-supplied string can't be
// persisted verbatim: only "relay" opts out of the "check" default.
Deno.test("createMonitor - omitted type defaults to 'check'", async () => {
  const m = await createMonitor({ name: uniq("t"), description: "" });
  assertEquals(m.type, "check");
});

Deno.test("createMonitor - type 'relay' is preserved", async () => {
  const m = await createMonitor({ name: uniq("t"), description: "", type: "relay" });
  assertEquals(m.type, "relay");
  assertEquals((await getMonitor({ monitorId: m.monitorId })).type, "relay"); // round-trips through KV
});

Deno.test("createMonitor - an unknown type value is coerced to 'check'", async () => {
  const m = await createMonitor({ name: uniq("t"), description: "", type: "bogus" as unknown as MonitorType });
  assertEquals(m.type, "check");
  assertEquals((await getMonitor({ monitorId: m.monitorId })).type, "check");
});
