import { assert, assertEquals } from "jsr:@std/assert";
import { Sms } from "./mod.ts";
import type { RunResultDto } from "../../../../dto/run-result-dto.ts";
import type { AlertDto } from "../../../../dto/alert-dto.ts";

// Local stub for the Zapier SMS webhook, capturing the POSTed { number, message }.
function smsStub() {
  const bodies: Array<{ number: string; message: string }> = [];
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    bodies.push(await req.json());
    return new Response("ok");
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

// The incident: an "Activations SMS" monitor with a custom smsMessage tuned for a
// metric breach got a transport failure (HTTP 401 from the polled endpoint) and
// texted "Send some activation texts you idiot" verbatim — implying the metric
// breached when the check never measured it. The error must ride along.
Deno.test("Sms.send - a custom metric template still surfaces a transport error", async () => {
  const stub = smsStub();
  try {
    const run: RunResultDto = {
      runId: "r", monitorId: "m", monitorName: "Activations SMS",
      observed: 0, passed: false, timestamp: "2026-06-30T21:00:49.390Z",
      error: "HTTP 401 from https://sms-bot.thetechgoose.deno.net/canary/conversations",
    };
    const alert: AlertDto = { monitorId: "m", recipients: [], smsMessage: "Send some activation texts you idiot" };
    await new Sms("18432222986").send(run, alert);
    assertEquals(stub.bodies.length, 1);
    assert(stub.bodies[0].message.includes("Send some activation texts"));
    assert(stub.bodies[0].message.includes("HTTP 401"), `error not surfaced in SMS: ${stub.bodies[0].message}`);
  } finally {
    await stub.close();
  }
});
