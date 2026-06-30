import { Relay } from "../../impure/relay/relay.ts";
import { Monitor } from "../../impure/monitor/monitor.ts";
import { RunResult } from "../../impure/runResult/runResult.ts";
import { AlertChannel } from "../../impure/alertChannel/mod.ts";
import { clampRunRowToKvLimit, sanitizeCaptures } from "../_shared/persistRunAndAlert.ts";
import type { RelayFireDto } from "../../dto/relay-fire-dto.ts";
import type { AlertDto } from "../../dto/alert-dto.ts";
import { log, withRun } from "../../impure/_log.ts";

export interface RelayFireInput {
  monitorId: string;
  token: string;
  payload: RelayFireDto;
}

export interface RelayFireResult {
  runId: string;
  fired: boolean;
  channels: string[];
}

export function fireRelay(input: RelayFireInput): Promise<RelayFireResult> {
  // Correlate every log line for this fire, and reuse the id as the run's runId.
  const runId = crypto.randomUUID();
  return withRun(runId, () => fireRelayRun(runId, input));
}

async function fireRelayRun(runId: string, input: RelayFireInput): Promise<RelayFireResult> {
  log.info(`📮 relay.fire: starting for monitorId=${input.monitorId}`);

  // Auth — throws CanaryError(unauthorized, 401) when the monitor has no relay
  // config or the token doesn't match. Returns the config (numbers + template).
  const relay = await new Relay().verify(input.monitorId, input.token);

  // The monitor record supplies the display name (relays ARE monitors). A relay
  // whose config exists but whose monitor record is gone is a corrupt state — let
  // Monitor.get throw 404 rather than firing an unnamed run.
  const monitor = await new Monitor().get(input.monitorId);

  // The payload is from an untrusted external caller — coerce/ignore wrong types
  // so nothing bad reaches the persisted RunResultDto or the template engine.
  const error = typeof input.payload.error === "string" ? input.payload.error : undefined;
  const message = typeof input.payload.message === "string" ? input.payload.message : undefined;
  const observed = typeof input.payload.observed === "number" ? input.payload.observed : 0;
  const captures = sanitizeCaptures(input.payload.captures);

  // Persist the fire as a run under the monitor's own id so it lands in the
  // Reports tab natively (drill-in + purge come for free) — no synthetic id.
  const runResult = RunResult.build(
    input.monitorId,
    observed,
    false, // always a failure-style alert — a relay has no recovery semantics
    monitor.name, // monitorName → the default SMS reads "Canary FAILED: <name> — error: …"
    error,
    captures,
    { runId },
  );
  // Clamp at the same chokepoint cron/webhook use — a caller-supplied error or
  // captures of arbitrary size would otherwise throw on KV save and be dropped.
  const runResultDto = clampRunRowToKvLimit(runResult.toDto(), "relay.persist");
  try {
    await runResult.save(runResultDto);
    log.info(`✅ relay.persist: saved runId=${runResultDto.runId} at=${runResultDto.timestamp}`);
  } catch (e) {
    // Mirror persistRunAndAlert: a save failure must never swallow the SMS — the
    // whole point of a relay is to page on the error.
    log.error(`❌ relay.persist: run persist failed — continuing to send SMS: ${(e as Error).message}`);
  }

  // Dispatch to the relay's SMS numbers. The per-fire `message` (else the relay's
  // saved template) is applyVars'd with {monitor} {error} {observed} {timestamp}
  // {status} + captures. Reusing AlertChannel gets the SMS stagger + the
  // "fail one number, still send the rest" semantics for free.
  const smsMessage = message ?? relay.template;
  const alertDto: AlertDto = {
    monitorId: input.monitorId,
    recipients: relay.numbers.map((address) => ({ channel: "sms", address })),
    smsMessage,
  };
  const channel = AlertChannel.fromAlert(alertDto);
  const channels = channel.dispatchedLabels();
  try {
    log.debug(`🔍 relay.fire: dispatching to ${relay.numbers.length} number(s)`);
    await channel.send(runResultDto);
    log.info(`✅ relay.fire: SMS sent (${channels.length} number(s))`);
    return { runId: runResultDto.runId, fired: true, channels };
  } catch (e) {
    log.error(`❌ relay.fire: SMS dispatch failed (non-fatal) — ${(e as Error).message}`);
    return { runId: runResultDto.runId, fired: false, channels };
  }
}
