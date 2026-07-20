import { assert } from "jsr:@std/assert";
import { buildEmailBody } from "./mod.ts";
import type { RunResultDto } from "../../../../dto/run-result-dto.ts";

const base: RunResultDto = {
  runId: "run-1",
  monitorId: "mon-1",
  monitorName: "Autobottom Checks",
  observed: 5,
  passed: false,
  timestamp: "2026-06-04T18:41:17.708Z",
};

Deno.test("buildEmailBody - pretty-prints a JSON response body on failure", () => {
  const body = buildEmailBody({
    ...base,
    response: { status: 200, body: '{"ok":true,"unrecoveredErrors":5}' },
  });
  assert(body.includes("Monitor:   Autobottom Checks"));
  assert(body.includes("Response:"));
  // Pretty-printed: a space after the colon only exists once re-stringified.
  assert(body.includes('"unrecoveredErrors": 5'));
});

Deno.test("buildEmailBody - omits Response when the run carries none (e.g. recovered)", () => {
  const body = buildEmailBody({ ...base, passed: true });
  assert(!body.includes("Response:"));
});

Deno.test("buildEmailBody - passes a non-JSON body through raw", () => {
  const body = buildEmailBody({ ...base, response: { body: "upstream 502 bad gateway" } });
  assert(body.includes("Response:"));
  assert(body.includes("upstream 502 bad gateway"));
});

Deno.test("buildEmailBody - notes truncation", () => {
  const body = buildEmailBody({ ...base, response: { body: '{"a":1}', truncated: true } });
  assert(body.includes("(truncated)"));
});

Deno.test("buildEmailBody - heartbeat reads '✅ OK' with the observed count and a logs link", () => {
  const body = buildEmailBody(
    { ...base, observed: 0, passed: true },
    { reason: "heartbeat", logsUrl: "https://dash.deno.com/projects/app/logs" },
  );
  assert(body.includes("Status:    ✅ OK"), `status not OK: ${body}`);
  assert(body.includes("Observed:  0"));
  assert(body.includes("Logs:      https://dash.deno.com/projects/app/logs"), `logs link missing: ${body}`);
  // A passing run carries no response, so the all-clear stays clean.
  assert(!body.includes("Response:"));
});

Deno.test("buildEmailBody - a recovery still reads '✅ RECOVERED' (not OK)", () => {
  const body = buildEmailBody({ ...base, passed: true }, { reason: "recovery" });
  assert(body.includes("Status:    ✅ RECOVERED"), body);
});

Deno.test("buildEmailBody - no logs line when none is configured", () => {
  const body = buildEmailBody({ ...base, observed: 0, passed: true }, { reason: "heartbeat" });
  assert(!body.includes("Logs:"));
});

import { isHtmlBody } from "./mod.ts";

Deno.test("isHtmlBody - an HTML fragment is detected; prose with '<' is not", () => {
  assert(isHtmlBody('<div style="font-family:sans-serif">report</div>'));
  assert(isHtmlBody("  <table><tr><td>x</td></tr></table>"));
  assert(!isHtmlBody("Status: OK"));
  // A comparison in prose must never flip an email to HTML mode.
  assert(!isHtmlBody("observed <5 which is fine"));
  assert(!isHtmlBody("errors < threshold"));
});
