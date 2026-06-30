import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { fireRelay } from "./relay-fire.ts";
import { Relay } from "../../impure/relay/relay.ts";
import { RunResult } from "../../impure/runResult/runResult.ts";
import { CanaryError } from "../../dto/_shared.ts";

const uid = () => "test_" + crypto.randomUUID().replace(/-/g, "_");

// Stand up a local stub for the Zapier SMS webhook and point ZAPIER_SMS_URL at
// it, capturing each POSTed { number, message } body — the same "real fetch
// against a local server" idiom the SSRF tests use.
function smsStub(status = 200) {
  const bodies: Array<{ number: string; message: string }> = [];
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    bodies.push(await req.json());
    return new Response(status === 200 ? "ok" : "upstream boom", { status });
  });
  Deno.env.set("ZAPIER_SMS_URL", `http://127.0.0.1:${server.addr.port}/`);
  return {
    bodies,
    async close() {
      await server.shutdown();
      Deno.env.delete("ZAPIER_SMS_URL");
    },
  };
}

Deno.test("fireRelay - valid token persists a run and sends the error over SMS", async () => {
  const stub = smsStub();
  const name = uid();
  try {
    await new Relay().upsert({ name, numbers: ["18432222986"], token: "longenoughtoken" });
    const result = await fireRelay({ name, token: "longenoughtoken", payload: { error: "Stripe handler 500" } });
    assertEquals(result.fired, true);
    assertEquals(result.channels, ["sms"]);

    // The SMS body carries the error in the default message.
    assertEquals(stub.bodies.length, 1);
    assertEquals(stub.bodies[0].number, "18432222986");
    assert(stub.bodies[0].message.includes("Stripe handler 500"));

    // The fire is persisted under the synthetic "relay:<name>" monitorId so it
    // shows up in the Reports tab.
    const latest = await RunResult.getLatest(`relay:${name}`);
    assertEquals(latest?.passed, false);
    assertEquals(latest?.error, "Stripe handler 500");
    assertEquals(latest?.runId, result.runId);
  } finally {
    await new Relay().delete(name);
    await stub.close();
  }
});

Deno.test("fireRelay - a relay template expands {error} and captures", async () => {
  const stub = smsStub();
  const name = uid();
  try {
    await new Relay().upsert({
      name,
      numbers: ["18432222986"],
      token: "longenoughtoken",
      template: "ALERT {error} svc={service}",
    });
    await fireRelay({ name, token: "longenoughtoken", payload: { error: "boom", captures: { service: "payments" } } });
    assertEquals(stub.bodies[0].message, "ALERT boom svc=payments");
  } finally {
    await new Relay().delete(name);
    await stub.close();
  }
});

Deno.test("fireRelay - a per-fire message overrides the saved template and still expands {var}", async () => {
  const stub = smsStub();
  const name = uid();
  try {
    await new Relay().upsert({
      name,
      numbers: ["18432222986"],
      token: "longenoughtoken12",
      template: "FROM TEMPLATE {error}",
    });
    await fireRelay({
      name,
      token: "longenoughtoken12",
      payload: { message: "OVERRIDE {error} svc={service}", error: "boom", captures: { service: "pay" } },
    });
    // The per-fire message wins over the relay's saved template, and {var}
    // tokens still expand inside the override.
    assertEquals(stub.bodies[0].message, "OVERRIDE boom svc=pay");
  } finally {
    await new Relay().delete(name);
    await stub.close();
  }
});

Deno.test("fireRelay - an SMS dispatch failure is non-fatal: fired:false but the run is still persisted", async () => {
  const stub = smsStub(500); // Zapier returns non-2xx → Sms.send throws → AlertChannel.send rejects
  const name = uid();
  try {
    await new Relay().upsert({ name, numbers: ["18432222986"], token: "longenoughtoken12" });
    const result = await fireRelay({ name, token: "longenoughtoken12", payload: { error: "down" } });
    // The call resolves (doesn't reject) and reports the failure as fired:false,
    // while still naming the channel it attempted.
    assertEquals(result.fired, false);
    assertEquals(result.channels, ["sms"]);
    assertEquals(stub.bodies.length, 1); // it did attempt the send
    // The report record survives even though the SMS failed.
    const latest = await RunResult.getLatest(`relay:${name}`);
    assertEquals(latest?.passed, false);
    assertEquals(latest?.error, "down");
  } finally {
    await new Relay().delete(name);
    await stub.close();
  }
});

Deno.test("fireRelay - fans out to every configured number", async () => {
  // Set the stagger to 0 so the fan-out completes instantly instead of waiting
  // the 4s-per-extra-number throttle.
  Deno.env.set("SMS_STAGGER_MS", "0");
  const stub = smsStub();
  const name = uid();
  try {
    await new Relay().upsert({ name, numbers: ["18432222986", "18432222987"], token: "longenoughtoken12" });
    await fireRelay({ name, token: "longenoughtoken12", payload: { error: "boom" } });
    assertEquals(stub.bodies.length, 2);
    assertEquals(new Set(stub.bodies.map((b) => b.number)), new Set(["18432222986", "18432222987"]));
    // Every number gets the same expanded message.
    assertEquals(new Set(stub.bodies.map((b) => b.message)).size, 1);
  } finally {
    await new Relay().delete(name);
    await stub.close();
    Deno.env.delete("SMS_STAGGER_MS");
  }
});

Deno.test("fireRelay - wrong token is unauthorized (401) and sends nothing", async () => {
  const stub = smsStub();
  const name = uid();
  try {
    await new Relay().upsert({ name, numbers: ["18432222986"], token: "rightToken1" });
    const err = await assertRejects(
      () => fireRelay({ name, token: "wrongToken1", payload: { error: "x" } }),
      CanaryError,
      "Invalid relay token",
    );
    assertEquals((err as CanaryError).status, 401);
    assertEquals(stub.bodies.length, 0);
  } finally {
    await new Relay().delete(name);
    await stub.close();
  }
});
