import { assertEquals, assertRejects } from "jsr:@std/assert";
import { configureRelay } from "./relay-configure.ts";
import { createMonitor } from "../monitor-create/monitor-create.ts";
import { deleteRelay } from "../relay-delete/relay-delete.ts";
import { Monitor } from "../../impure/monitor/monitor.ts";
import { Relay } from "../../impure/relay/relay.ts";
import { CanaryError } from "../../dto/_shared.ts";

const uid = () => crypto.randomUUID();
const uniq = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;
const TOKEN = "a-long-enough-relay-token"; // ≥ 16 chars

// Create a bare type:"relay" monitor (no relay config yet) so configureRelay's
// existence/type guard passes. Returns its monitorId; clean up with deleteRelay.
async function relayMonitor(): Promise<string> {
  const m = await createMonitor({ name: uniq("relay-cfg"), description: "", type: "relay" });
  return m.monitorId;
}

Deno.test("configureRelay - valid input upserts and returns a hash-free public config", async () => {
  const monitorId = await relayMonitor();
  const result = await configureRelay({ monitorId, numbers: ["18432222986", "8432222986"], token: TOKEN });
  assertEquals(result.numbers.length, 2);
  assertEquals(result.hasTemplate, false);
  assertEquals((result as unknown as Record<string, unknown>).tokenHash, undefined);
  await deleteRelay({ monitorId });
});

Deno.test("configureRelay - omitting the token on reconfigure keeps the current one", async () => {
  const monitorId = await relayMonitor();
  await configureRelay({ monitorId, numbers: ["18432222986"], token: TOKEN });
  await configureRelay({ monitorId, numbers: ["18432222987", "18432222988"] }); // numbers only
  const stored = await new Relay().verify(monitorId, TOKEN); // original token still authenticates
  assertEquals(stored.numbers, ["18432222987", "18432222988"]);
  await deleteRelay({ monitorId });
});

Deno.test("configureRelay - first configure with no token is rejected", async () => {
  const monitorId = await relayMonitor();
  await assertRejects(
    () => configureRelay({ monitorId, numbers: ["18432222986"] }),
    CanaryError,
    "token is required",
  );
  await deleteRelay({ monitorId });
});

Deno.test("configureRelay - refuses to write a relay config onto a check monitor", async () => {
  const m = await createMonitor({ name: uniq("chk"), description: "" }); // defaults to type "check"
  await assertRejects(
    () => configureRelay({ monitorId: m.monitorId, numbers: ["18432222986"], token: TOKEN }),
    CanaryError,
    "is not a relay",
  );
  // The check monitor must be untouched, and no relay config written for it.
  assertEquals((await new Monitor().get(m.monitorId)).type, "check");
  assertEquals(await new Relay().peek(m.monitorId), null);
});

Deno.test("configureRelay - rejects an unknown monitorId", async () => {
  await assertRejects(
    () => configureRelay({ monitorId: uid(), numbers: ["18432222986"], token: TOKEN }),
    CanaryError,
    "not found",
  );
});

Deno.test("configureRelay - rejects empty numbers", async () => {
  await assertRejects(
    () => configureRelay({ monitorId: uid(), numbers: [], token: TOKEN }),
    CanaryError,
    "non-empty array",
  );
});

Deno.test("configureRelay - rejects a malformed phone number", async () => {
  await assertRejects(
    () => configureRelay({ monitorId: uid(), numbers: ["123"], token: TOKEN }),
    CanaryError,
    "10 or 11 digits",
  );
});

Deno.test("configureRelay - rejects more than 5 numbers", async () => {
  await assertRejects(
    () =>
      configureRelay({
        monitorId: uid(),
        numbers: ["18432222981", "18432222982", "18432222983", "18432222984", "18432222985", "18432222986"],
        token: TOKEN,
      }),
    CanaryError,
    "at most 5",
  );
});

Deno.test("configureRelay - rejects a short token", async () => {
  const monitorId = await relayMonitor();
  await assertRejects(
    () => configureRelay({ monitorId, numbers: ["18432222986"], token: "short" }),
    CanaryError,
    "at least 16",
  );
  await deleteRelay({ monitorId });
});

Deno.test("configureRelay - rejects a non-string template", async () => {
  await assertRejects(
    () =>
      configureRelay({
        monitorId: uid(),
        numbers: ["18432222986"],
        token: TOKEN,
        template: 42 as unknown as string,
      }),
    CanaryError,
    "template must be a string",
  );
});
