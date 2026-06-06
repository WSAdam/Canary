import { assertEquals, assertRejects } from "jsr:@std/assert";
import { createMonitor } from "../monitor-create/monitor-create.ts";
import { updateMonitor } from "./monitor-update.ts";
import { getMonitor } from "../monitor-get/monitor-get.ts";
import { CanaryError } from "../../dto/_shared.ts";

// Unique names per test so the shared (local, non-prod) KV can't collide.
const uniq = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;

Deno.test("updateMonitor - renames the monitor and frees the old name", async () => {
  const oldName = uniq("rename-old");
  const newName = uniq("rename-new");
  const created = await createMonitor({ name: oldName, description: "d1" });

  const updated = await updateMonitor({ monitorId: created.monitorId, name: newName, description: "d2" });
  assertEquals(updated.name, newName);
  assertEquals(updated.description, "d2");

  // The record reflects the new name.
  assertEquals((await getMonitor({ monitorId: created.monitorId })).name, newName);

  // The old name index was released, so it can be reused by a new monitor.
  const reused = await createMonitor({ name: oldName, description: "reuse" });
  assertEquals(reused.name, oldName);
});

Deno.test("updateMonitor - description-only update keeps the name", async () => {
  const name = uniq("descedit");
  const created = await createMonitor({ name, description: "before" });
  const updated = await updateMonitor({ monitorId: created.monitorId, name, description: "after" });
  assertEquals(updated.name, name);
  assertEquals(updated.description, "after");
});

Deno.test("updateMonitor - updating a nonexistent monitor throws not-found", async () => {
  await assertRejects(
    () => updateMonitor({ monitorId: crypto.randomUUID(), name: uniq("ghost"), description: "" }),
    CanaryError,
    "not found",
  );
});

Deno.test("updateMonitor - renaming onto a taken name throws duplicate-name", async () => {
  const a = uniq("dup-a");
  const b = uniq("dup-b");
  const mA = await createMonitor({ name: a, description: "" });
  await createMonitor({ name: b, description: "" });
  await assertRejects(
    () => updateMonitor({ monitorId: mA.monitorId, name: b, description: "" }),
    CanaryError,
    "already exists",
  );
});
