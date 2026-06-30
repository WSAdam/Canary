import { assertEquals, assertRejects } from "jsr:@std/assert";
import { configureRelay } from "./relay-configure.ts";
import { Relay } from "../../impure/relay/relay.ts";
import { CanaryError } from "../../dto/_shared.ts";

const uid = () => crypto.randomUUID();
const TOKEN = "a-long-enough-relay-token"; // ≥ 16 chars

Deno.test("configureRelay - valid input upserts and returns a hash-free public config", async () => {
  const monitorId = uid();
  const result = await configureRelay({ monitorId, numbers: ["18432222986", "8432222986"], token: TOKEN });
  assertEquals(result.numbers.length, 2);
  assertEquals(result.hasTemplate, false);
  assertEquals((result as unknown as Record<string, unknown>).tokenHash, undefined);
  await new Relay().delete(monitorId);
});

Deno.test("configureRelay - omitting the token on reconfigure keeps the current one", async () => {
  const monitorId = uid();
  await configureRelay({ monitorId, numbers: ["18432222986"], token: TOKEN });
  // Reconfigure numbers only — no token supplied.
  await configureRelay({ monitorId, numbers: ["18432222987", "18432222988"] });
  const relay = new Relay();
  // The original token still authenticates, and the numbers were updated.
  const stored = await relay.verify(monitorId, TOKEN);
  assertEquals(stored.numbers, ["18432222987", "18432222988"]);
  await relay.delete(monitorId);
});

Deno.test("configureRelay - first configure with no token is rejected", async () => {
  await assertRejects(
    () => configureRelay({ monitorId: uid(), numbers: ["18432222986"] }),
    CanaryError,
    "token is required",
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
  await assertRejects(
    () => configureRelay({ monitorId: uid(), numbers: ["18432222986"], token: "short" }),
    CanaryError,
    "at least 16",
  );
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
