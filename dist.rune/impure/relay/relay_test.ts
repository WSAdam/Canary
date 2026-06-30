import { assertEquals, assertRejects } from "jsr:@std/assert";
import { Relay } from "./relay.ts";
import { CanaryError } from "../../dto/_shared.ts";

// Exercises the real (local) Deno KV store, keyed by monitorId. IDs are unique
// per run so repeated runs don't collide.
const uid = () => crypto.randomUUID();

Deno.test("Relay - upsert, get, peek, verify, delete roundtrip", async () => {
  const relay = new Relay();
  const monitorId = uid();
  const tokenHash = await Relay.hash("a-long-relay-token");

  const pub = await relay.upsert(monitorId, ["18432222986"], tokenHash, "{error}");
  assertEquals(pub.numbers, ["18432222986"]);
  assertEquals(pub.hasTemplate, true);
  // The public projection must NEVER carry the token hash.
  assertEquals((pub as unknown as Record<string, unknown>).tokenHash, undefined);

  const got = await relay.get(monitorId);
  assertEquals(got.numbers, ["18432222986"]);
  assertEquals((got as unknown as Record<string, unknown>).tokenHash, undefined);

  // peek returns the raw config including the hash (server-side only).
  const raw = await relay.peek(monitorId);
  assertEquals(raw?.tokenHash, tokenHash);
  assertEquals(raw?.template, "{error}");

  // verify returns the stored config on the correct token.
  const stored = await relay.verify(monitorId, "a-long-relay-token");
  assertEquals(stored.numbers, ["18432222986"]);

  await relay.delete(monitorId);
  await assertRejects(() => relay.get(monitorId), CanaryError, "not found");
  assertEquals(await relay.peek(monitorId), null);
});

Deno.test("Relay.verify - wrong token is unauthorized (401)", async () => {
  const relay = new Relay();
  const monitorId = uid();
  await relay.upsert(monitorId, ["18432222986"], await Relay.hash("the-right-token-x"));
  const err = await assertRejects(() => relay.verify(monitorId, "the-wrong-token-x"), CanaryError, "Invalid relay token");
  assertEquals((err as CanaryError).status, 401);
  await relay.delete(monitorId);
});

Deno.test("Relay.verify - a monitor with no relay config is unauthorized, not 404", async () => {
  const relay = new Relay();
  const err = await assertRejects(() => relay.verify(uid(), "whatever-token-x"), CanaryError, "Invalid relay token");
  assertEquals((err as CanaryError).status, 401);
});
