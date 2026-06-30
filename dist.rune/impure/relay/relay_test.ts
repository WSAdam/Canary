import { assertEquals, assertRejects } from "jsr:@std/assert";
import { Relay } from "./relay.ts";
import { CanaryError } from "../../dto/_shared.ts";

// Exercises the real (local) Deno KV store. Names are unique per run so repeated
// runs don't collide.
const uid = () => "test_" + crypto.randomUUID().replace(/-/g, "_");

Deno.test("Relay - upsert, get, list, verify, delete roundtrip", async () => {
  const relay = new Relay();
  const name = uid();

  const pub = await relay.upsert({ name, numbers: ["18432222986"], token: "supersecret", template: "{error}" });
  assertEquals(pub.name, name);
  assertEquals(pub.numbers, ["18432222986"]);
  assertEquals(pub.hasTemplate, true);
  // The public projection must NEVER carry the token hash.
  assertEquals((pub as unknown as Record<string, unknown>).tokenHash, undefined);

  const got = await relay.get(name);
  assertEquals(got.name, name);
  assertEquals(got.hasTemplate, true);

  const listed = await relay.list();
  const entry = listed.relays.find((r) => r.name === name);
  assertEquals(entry?.numbers, ["18432222986"]);
  assertEquals((entry as unknown as Record<string, unknown>).tokenHash, undefined);

  // verify returns the stored dto (numbers + template) on the correct token.
  const stored = await relay.verify(name, "supersecret");
  assertEquals(stored.numbers, ["18432222986"]);
  assertEquals(stored.template, "{error}");

  await relay.delete(name);
  await assertRejects(() => relay.get(name), CanaryError, "not found");
});

Deno.test("Relay.verify - wrong token is unauthorized (401)", async () => {
  const relay = new Relay();
  const name = uid();
  await relay.upsert({ name, numbers: ["18432222986"], token: "rightToken1" });
  const err = await assertRejects(() => relay.verify(name, "wrongToken1"), CanaryError, "Invalid relay token");
  assertEquals((err as CanaryError).status, 401);
  await relay.delete(name);
});

Deno.test("Relay.verify - unknown relay is unauthorized, not 404 (names can't be probed)", async () => {
  const relay = new Relay();
  const err = await assertRejects(
    () => relay.verify("missing_" + crypto.randomUUID().replace(/-/g, ""), "whatever"),
    CanaryError,
    "Invalid relay token",
  );
  assertEquals((err as CanaryError).status, 401);
});

Deno.test("Relay.upsert - re-saving the same name rotates the token", async () => {
  const relay = new Relay();
  const name = uid();
  await relay.upsert({ name, numbers: ["18432222986"], token: "tokenOne1" });
  await relay.upsert({ name, numbers: ["18432222986"], token: "tokenTwo2" });
  await assertRejects(() => relay.verify(name, "tokenOne1"), CanaryError, "Invalid relay token");
  await relay.verify(name, "tokenTwo2"); // new token authenticates
  await relay.delete(name);
});
