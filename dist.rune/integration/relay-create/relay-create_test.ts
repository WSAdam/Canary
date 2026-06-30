import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { createRelayMonitor } from "./relay-create.ts";
import { getMonitor } from "../monitor-get/monitor-get.ts";
import { deleteRelay } from "../relay-delete/relay-delete.ts";
import { Relay } from "../../impure/relay/relay.ts";
import { CanaryError } from "../../dto/_shared.ts";

const uniq = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;
const TOKEN = "a-long-enough-relay-token";

Deno.test("createRelayMonitor - provisions a type:relay monitor plus its relay config", async () => {
  const name = uniq("relay");
  const res = await createRelayMonitor({ name, numbers: ["18432222986"], token: TOKEN, template: "{error}" });
  assert(res.monitorId);

  // It's a real monitor, typed "relay".
  const monitor = await getMonitor({ monitorId: res.monitorId });
  assertEquals(monitor.name, name);
  assertEquals(monitor.type, "relay");

  // The relay config persisted and the token authenticates.
  const stored = await new Relay().verify(res.monitorId, TOKEN);
  assertEquals(stored.numbers, ["18432222986"]);

  await deleteRelay({ monitorId: res.monitorId });
});

Deno.test("createRelayMonitor - rolls back the monitor when the relay config is invalid", async () => {
  const name = uniq("relay-bad");
  await assertRejects(
    () => createRelayMonitor({ name, numbers: ["123"], token: TOKEN }), // bad phone number
    CanaryError,
    "10 or 11 digits",
  );
  // The monitor must not survive a failed config (rollback), so the name is free
  // to reuse — a second create with the same name succeeds rather than 409ing.
  const ok = await createRelayMonitor({ name, numbers: ["18432222986"], token: TOKEN });
  assert(ok.monitorId);
  await deleteRelay({ monitorId: ok.monitorId });
});
