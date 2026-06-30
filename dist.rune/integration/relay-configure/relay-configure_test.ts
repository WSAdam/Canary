import { assertEquals, assertRejects } from "jsr:@std/assert";
import { configureRelay } from "./relay-configure.ts";
import { Relay } from "../../impure/relay/relay.ts";
import { CanaryError } from "../../dto/_shared.ts";

const uid = () => "test_" + crypto.randomUUID().replace(/-/g, "_");

Deno.test("configureRelay - valid input upserts and returns a hash-free public relay", async () => {
  const name = uid();
  const result = await configureRelay({ name, numbers: ["18432222986", "8432222986"], token: "longenoughtoken" });
  assertEquals(result.name, name);
  assertEquals(result.numbers.length, 2);
  assertEquals(result.hasTemplate, false);
  assertEquals((result as unknown as Record<string, unknown>).tokenHash, undefined);
  await new Relay().delete(name);
});

Deno.test("configureRelay - rejects a bad name charset", async () => {
  await assertRejects(
    () => configureRelay({ name: "bad name!", numbers: ["18432222986"], token: "longenoughtoken" }),
    CanaryError,
    "may only contain",
  );
});

Deno.test("configureRelay - rejects empty numbers", async () => {
  await assertRejects(
    () => configureRelay({ name: uid(), numbers: [], token: "longenoughtoken" }),
    CanaryError,
    "non-empty array",
  );
});

Deno.test("configureRelay - rejects a malformed phone number", async () => {
  await assertRejects(
    () => configureRelay({ name: uid(), numbers: ["123"], token: "longenoughtoken" }),
    CanaryError,
    "10 or 11 digits",
  );
});

Deno.test("configureRelay - rejects more than 5 numbers", async () => {
  await assertRejects(
    () =>
      configureRelay({
        name: uid(),
        numbers: ["18432222981", "18432222982", "18432222983", "18432222984", "18432222985", "18432222986"],
        token: "longenoughtoken",
      }),
    CanaryError,
    "at most 5",
  );
});

Deno.test("configureRelay - rejects a short token", async () => {
  await assertRejects(
    () => configureRelay({ name: uid(), numbers: ["18432222986"], token: "short" }),
    CanaryError,
    "at least 8",
  );
});

Deno.test("configureRelay - rejects a non-string template", async () => {
  await assertRejects(
    () =>
      configureRelay({
        name: uid(),
        numbers: ["18432222986"],
        token: "longenoughtoken",
        template: 42 as unknown as string,
      }),
    CanaryError,
    "template must be a string",
  );
});
