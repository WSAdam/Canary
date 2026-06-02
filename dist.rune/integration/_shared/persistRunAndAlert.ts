import type { RunResultDto } from "../../dto/run-result-dto.ts";
import type { AlertDto } from "../../dto/alert-dto.ts";
import { Alert } from "../../impure/alert/alert.ts";
import { RunResult } from "../../impure/runResult/runResult.ts";
import { AlertChannel } from "../../impure/alertChannel/mod.ts";

export interface PersistAndAlertInput {
  monitorId: string;
  monitorName?: string;
  observed: number;
  passed: boolean;
  error?: string;
  captures?: Record<string, string>;
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
  console.log(`🔍 ${tag}: previousRun=${previousRun === null ? "null" : `passed=${previousRun.passed} observed=${previousRun.observed}`}`);

  const runResult = RunResult.build(input.monitorId, input.observed, input.passed, input.monitorName, input.error, input.captures);
  const runResultDto = runResult.toDto();
  await runResult.save(runResultDto);
  console.log(`✅ ${tag}: saved runId=${runResultDto.runId}`);

  const isRecovery = previousRun !== null && !previousRun.passed && input.passed;
  // Alert on ANY failure (down endpoint, non-2xx, timeout, extraction failure,
  // or threshold breach), and on recovery when the monitor opts in.
  const shouldAlert = !input.passed || (isRecovery && input.notifyOnRecover);
  console.log(`🔍 ${tag}: passed=${input.passed} error=${input.error ?? "none"} isRecovery=${isRecovery} notifyOnRecover=${input.notifyOnRecover} shouldAlert=${shouldAlert}`);

  if (!shouldAlert) {
    console.log(`🔍 ${tag}: no alert needed`);
    return { runResult: runResultDto, fired: false, channels: [] };
  }

  console.log(`⚠️ ${tag}: alerting — reason=${input.passed ? "recovery" : "failure"}`);
  let alertDto: AlertDto | null = null;
  try {
    const alert = new Alert();
    alertDto = await alert.get(input.monitorId);
    console.log(`🔍 ${tag}: alert config loaded recipients=${alertDto.recipients.length}`);
  } catch (e) {
    const err = e as Error & { fault?: string };
    if (err.fault === "not-found") {
      console.log(`⚠️ ${tag}: no alert configured for monitor ${input.monitorId} — skipping`);
    } else {
      console.log(`⚠️ ${tag}: alert config load failed (non-fatal) — ${err.message}`, err.stack);
    }
    return { runResult: runResultDto, fired: false, channels: [] };
  }

  if (alertDto.recipients.length === 0) {
    console.log(`⚠️ ${tag}: alert configured for ${input.monitorId} but recipients=[] — skipping`);
    return { runResult: runResultDto, fired: false, channels: [] };
  }

  const effectiveAlert = input.alertOverrides ? applyOverrides(alertDto, input.alertOverrides) : alertDto;
  const channels = effectiveAlert.recipients.map((r) => r.channel);

  try {
    const channel = AlertChannel.fromAlert(effectiveAlert);
    console.log(`🔍 ${tag}: dispatching to ${effectiveAlert.recipients.length} recipient(s) — channels=[${channels.join(", ")}]`);
    await channel.send(runResultDto);
    console.log(`✅ ${tag}: alert sent`);
    return { runResult: runResultDto, fired: true, channels };
  } catch (e) {
    const err = e as Error;
    console.log(`❌ ${tag}: alert dispatch failed (non-fatal) — ${err.message}`, err.stack);
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
