import { assertEquals, assertRejects } from "jsr:@std/assert";
import { configureAlert } from "./alert-configure.ts";
import { createMonitor } from "../monitor-create/monitor-create.ts";
import { CanaryError } from "../../dto/_shared.ts";

// configureAlert rejects orphan alerts (no owning monitor), so seed a real
// monitor first and exercise the recipient-shape validation against its id.
async function seedMonitor(): Promise<string> {
  const m = await createMonitor({ name: `alert-cfg-${crypto.randomUUID()}`, description: "" });
  return m.monitorId;
}

Deno.test("configureAlert - rejects a missing recipients field with 400 (not a 500)", async () => {
  const monitorId = await seedMonitor();
  const err = await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => configureAlert({ monitorId } as any),
    CanaryError,
  );
  assertEquals(err.status, 400);
});

Deno.test("configureAlert - rejects a non-array recipients with 400", async () => {
  const monitorId = await seedMonitor();
  const err = await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => configureAlert({ monitorId, recipients: "x" as any }),
    CanaryError,
  );
  assertEquals(err.status, 400);
});

Deno.test("configureAlert - rejects an unknown channel with 400", async () => {
  const monitorId = await seedMonitor();
  const err = await assertRejects(
    () => configureAlert({ monitorId, recipients: [{ channel: "emial", address: "a@b.c" }] }),
    CanaryError,
  );
  assertEquals(err.status, 400);
});

Deno.test("configureAlert - rejects a blank address with 400", async () => {
  const monitorId = await seedMonitor();
  const err = await assertRejects(
    () => configureAlert({ monitorId, recipients: [{ channel: "email", address: "" }] }),
    CanaryError,
  );
  assertEquals(err.status, 400);
});

Deno.test("configureAlert - rejects a non-string template field with 400", async () => {
  const monitorId = await seedMonitor();
  const err = await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => configureAlert({ monitorId, recipients: [{ channel: "email", address: "a@b.c" }], emailSubject: 123 as any }),
    CanaryError,
  );
  assertEquals(err.status, 400);
});

Deno.test("configureAlert - rejects an orphan alert (no monitor) with 404", async () => {
  const err = await assertRejects(
    () => configureAlert({ monitorId: "does-not-exist", recipients: [{ channel: "email", address: "a@b.c" }] }),
    CanaryError,
  );
  assertEquals(err.status, 404);
});
