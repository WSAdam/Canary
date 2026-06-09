import type { RunResultDto, RunRequestDetailDto, RunResponseDetailDto } from "../../dto/run-result-dto.ts";
import type { AlertDto } from "../../dto/alert-dto.ts";
import { Alert } from "../../impure/alert/alert.ts";
import { RunResult } from "../../impure/runResult/runResult.ts";
import { AlertChannel } from "../../impure/alertChannel/mod.ts";
import { log } from "../../impure/_log.ts";

export interface PersistAndAlertInput {
  runId?: string;
  monitorId: string;
  monitorName?: string;
  observed: number;
  passed: boolean;
  error?: string;
  captures?: Record<string, string>;
  request?: RunRequestDetailDto;
  response?: RunResponseDetailDto;
  notifyOnRecover: boolean;
  source: "cron" | "webhook";
  alertOverrides?: { message?: string; title?: string };
}

export interface PersistAndAlertResult {
  runResult: RunResultDto;
  fired: boolean;
  channels: string[];
}

export async function persistRunAndAlert(input: PersistAndAlertInput): Promise<PersistAndAlertResult> {
  const tag = `${input.source}.persist`;

  const previousRun = await RunResult.getLatest(input.monitorId);
  log.debug(`🔍 ${tag}: previousRun=${previousRun === null ? "null" : `passed=${previousRun.passed} observed=${previousRun.observed}`}`);

  const runResult = RunResult.build(
    input.monitorId,
    input.observed,
    input.passed,
    input.monitorName,
    input.error,
    input.captures,
    { runId: input.runId, request: input.request, response: input.response },
  );
  const runResultDto = runResult.toDto();
  await runResult.save(runResultDto);
  // Log the exact key (runId + timestamp) so a row can be purged manually from
  // the Reports tab even in the unlikely event it ever becomes unreadable.
  log.info(`✅ ${tag}: saved runId=${runResultDto.runId} at=${runResultDto.timestamp}`);

  const isRecovery = previousRun !== null && !previousRun.passed && input.passed;
  // Alert on ANY failure (down endpoint, non-2xx, timeout, extraction failure,
  // or threshold breach), and on recovery when the monitor opts in.
  const shouldAlert = !input.passed || (isRecovery && input.notifyOnRecover);
  log.debug(`🔍 ${tag}: passed=${input.passed} error=${input.error ?? "none"} isRecovery=${isRecovery} notifyOnRecover=${input.notifyOnRecover} shouldAlert=${shouldAlert}`);

  if (!shouldAlert) {
    log.debug(`🔍 ${tag}: no alert needed`);
    return { runResult: runResultDto, fired: false, channels: [] };
  }

  log.warn(`⚠️ ${tag}: alerting — reason=${input.passed ? "recovery" : "failure"}`);
  let alertDto: AlertDto | null = null;
  try {
    const alert = new Alert();
    alertDto = await alert.get(input.monitorId);
    log.debug(`🔍 ${tag}: alert config loaded recipients=${alertDto.recipients.length}`);
  } catch (e) {
    const err = e as Error & { fault?: string };
    if (err.fault === "not-found") {
      log.warn(`⚠️ ${tag}: no alert configured for monitor ${input.monitorId} — skipping`);
    } else {
      log.warn(`⚠️ ${tag}: alert config load failed (non-fatal) — ${err.message}`, err.stack);
    }
    return { runResult: runResultDto, fired: false, channels: [] };
  }

  if (alertDto.recipients.length === 0) {
    log.warn(`⚠️ ${tag}: alert configured for ${input.monitorId} but recipients=[] — skipping`);
    return { runResult: runResultDto, fired: false, channels: [] };
  }

  const effectiveAlert = input.alertOverrides ? applyOverrides(alertDto, input.alertOverrides) : alertDto;
  const channels = effectiveAlert.recipients.map((r) => r.channel);

  try {
    const channel = AlertChannel.fromAlert(effectiveAlert);
    log.debug(`🔍 ${tag}: dispatching to ${effectiveAlert.recipients.length} recipient(s) — channels=[${channels.join(", ")}]`);
    await channel.send(runResultDto);
    log.info(`✅ ${tag}: alert sent`);
    return { runResult: runResultDto, fired: true, channels };
  } catch (e) {
    const err = e as Error;
    log.error(`❌ ${tag}: alert dispatch failed (non-fatal) — ${err.message}`, err.stack);
    return { runResult: runResultDto, fired: false, channels };
  }
}

function applyOverrides(alert: AlertDto, ov: { message?: string; title?: string }): AlertDto {
  return {
    ...alert,
    emailSubject: ov.title ?? alert.emailSubject,
    ntfyTitle: ov.title ?? alert.ntfyTitle,
    emailMessage: ov.message ?? alert.emailMessage,
    smsMessage: ov.message ?? alert.smsMessage,
    ntfyMessage: ov.message ?? alert.ntfyMessage,
  };
}
