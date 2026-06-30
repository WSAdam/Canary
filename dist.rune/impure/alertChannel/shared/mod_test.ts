import { assert, assertEquals } from "jsr:@std/assert";
import { applyVars, BaseAlertChannel, buildVars, renderAlertMessage } from "./mod.ts";
import type { RunResultDto } from "../../../dto/run-result-dto.ts";

Deno.test("BaseAlertChannel exists", () => {
  assertEquals(typeof BaseAlertChannel, "function");
});

Deno.test("applyVars - substitutes known tokens", () => {
  assertEquals(applyVars("hi {monitor}: {status}", { monitor: "api", status: "FAILED" }), "hi api: FAILED");
});

Deno.test("applyVars - leaves unknown tokens untouched", () => {
  assertEquals(applyVars("{a} {b}", { a: "1" }), "1 {b}");
});

Deno.test("applyVars - inserts $ values literally (no String.replace special patterns)", () => {
  // Regression for the $-corruption bug: a captured value like "$5" / "$&" must
  // be inserted verbatim, not interpreted as a replacement pattern.
  assertEquals(applyVars("price is {p}", { p: "$5" }), "price is $5");
  assertEquals(applyVars("x {p}", { p: "$&$1$$" }), "x $&$1$$");
});

Deno.test("buildVars - exposes error and status for a failed run", () => {
  const run: RunResultDto = {
    runId: "r1",
    monitorId: "m1",
    monitorName: "API",
    observed: 0,
    passed: false,
    timestamp: "2026-06-02T00:00:00.000Z",
    error: "HTTP 500 from https://api",
  };
  const vars = buildVars(run);
  assertEquals(vars.status, "FAILED");
  assertEquals(vars.monitor, "API");
  assertEquals(vars.error, "HTTP 500 from https://api");
  assertEquals(vars.observed, "0");
});

// Regression for the false-alarm fuckup: an "Activations SMS" monitor whose
// smsMessage is "Send some activation texts" must NOT be sent verbatim when the
// check actually failed with a transport error (HTTP 401) — the recipient would
// think the metric breached when the check never measured it. The error must be
// appended so the alert is honest.
Deno.test("renderAlertMessage - appends the error when a custom template (no {error}) hides a transport failure", () => {
  const run: RunResultDto = {
    runId: "r", monitorId: "m", monitorName: "Activations SMS",
    observed: 0, passed: false, timestamp: "2026-06-30T21:00:49.390Z",
    error: "HTTP 401 from https://sms-bot.thetechgoose.deno.net/canary/conversations",
  };
  const msg = renderAlertMessage("Send some activation texts you idiot", run, buildVars(run), "fallback");
  assert(msg.startsWith("Send some activation texts you idiot"));
  assert(msg.includes("HTTP 401"), `error not surfaced: ${msg}`);
});

Deno.test("renderAlertMessage - does NOT double-append when the template already uses {error} (relay-style)", () => {
  const run: RunResultDto = {
    runId: "r", monitorId: "m", monitorName: "relay",
    observed: 0, passed: false, timestamp: "2026-06-30T21:00:00.000Z",
    error: "boom",
  };
  const msg = renderAlertMessage("🚨 {monitor}: {error}", run, buildVars(run), "fallback");
  assertEquals(msg, "🚨 relay: boom"); // no trailing " — error: boom"
});

Deno.test("renderAlertMessage - a clean metric breach (no error) keeps the custom template verbatim", () => {
  const run: RunResultDto = {
    runId: "r", monitorId: "m", monitorName: "Activations SMS",
    observed: 0, passed: false, timestamp: "2026-06-30T21:00:00.000Z",
    // no error → the metric was actually measured and breached
  };
  assertEquals(
    renderAlertMessage("Send some activation texts you idiot", run, buildVars(run), "fallback"),
    "Send some activation texts you idiot",
  );
});

Deno.test("renderAlertMessage - no template uses the channel default (which already carries the error)", () => {
  const run: RunResultDto = {
    runId: "r", monitorId: "m", observed: 0, passed: false,
    timestamp: "2026-06-30T21:00:00.000Z", error: "HTTP 401",
  };
  // Default body already mentions the error → returned as-is, not double-tagged.
  assertEquals(renderAlertMessage(undefined, run, buildVars(run), "Canary FAILED — error: HTTP 401"), "Canary FAILED — error: HTTP 401");
});

Deno.test("buildVars - error empty when absent; captures merged; falls back to id", () => {
  const run: RunResultDto = {
    runId: "r2",
    monitorId: "m2",
    observed: 7,
    passed: true,
    timestamp: "2026-06-02T00:00:00.000Z",
    captures: { city: "NYC" },
  };
  const vars = buildVars(run);
  assertEquals(vars.status, "RECOVERED");
  assertEquals(vars.error, "");
  assertEquals(vars.city, "NYC");
  assertEquals(vars.monitor, "m2");
});
