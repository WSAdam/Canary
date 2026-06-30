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
  // Persist the run but skip alert dispatch entirely (e.g. a setup verification
  // run that must not page recipients before the integration is confirmed).
  suppressAlert?: boolean;
}

export interface PersistAndAlertResult {
  runResult: RunResultDto;
  fired: boolean;
  channels: string[];
}

// Deno KV rejects a single value over ~64KiB by THROWING on commit. That throw
// is caught below (so a failing check still pages), which means an over-limit
// row is SILENTLY DROPPED from history. The cron runner pre-bounds its fields,
// but other callers (webhook-fire) pass caller-supplied error/captures of
// arbitrary size — so enforce the ceiling HERE, at the single shared persistence
// chokepoint, where no current or future path can bypass it.
const KV_VALUE_SAFE_BYTES = 56 * 1024; // headroom under KV's ~64KiB hard limit
const _enc = new TextEncoder();
const _dec = new TextDecoder();

function jsonBytes(v: unknown): number {
  return _enc.encode(JSON.stringify(v)).length;
}

function truncateUtf8(s: string, maxBytes: number): string {
  const bytes = _enc.encode(s);
  if (bytes.length <= maxBytes) return s;
  return _dec.decode(bytes.subarray(0, maxBytes)).replace(/�$/, "") + "…(truncated)";
}

/**
 * Guarantee the serialized run row fits under KV's per-value limit by trimming
 * the largest contributors in priority order (captures are best-effort context,
 * so they go first; then bodies; then the error; then url/headers), re-checking
 * after each step and stopping as soon as it fits. Returns a clamped COPY.
 */
export function clampRunRowToKvLimit(dto: RunResultDto, tag = "persist"): RunResultDto {
  if (jsonBytes(dto) <= KV_VALUE_SAFE_BYTES) return dto;
  const d: RunResultDto = { ...dto };
  const fits = () => jsonBytes(d) <= KV_VALUE_SAFE_BYTES;
  const steps: Array<() => string | undefined> = [
    () => { if (d.captures && Object.keys(d.captures).length) { d.captures = undefined; return "captures"; } },
    () => { if (d.response?.body) { d.response = { ...d.response, body: truncateUtf8(d.response.body, 8 * 1024), truncated: true }; return "response.body"; } },
    () => { if (d.request?.body) { d.request = { ...d.request, body: truncateUtf8(d.request.body, 8 * 1024) }; return "request.body"; } },
    () => { if (d.error) { d.error = truncateUtf8(d.error, 1024); return "error"; } },
    () => { if (d.request) { d.request = { ...d.request, url: truncateUtf8(d.request.url, 1024), headers: {} }; return "request.url+headers"; } },
  ];
  const trimmed: string[] = [];
  for (const step of steps) {
    if (fits()) break;
    const what = step();
    if (what) trimmed.push(what);
  }
  log.warn(`⚠️ ${tag}: run row exceeded ${KV_VALUE_SAFE_BYTES}B — trimmed [${trimmed.join(", ")}] to fit KV's per-value limit`);
  return d;
}

/** Keep only string-coercible entries from an externally-supplied captures map so
 *  the stored RunResultDto.captures (Record<string,string>) stays well-typed and
 *  every value is safe to feed into the alert template engine. Shared by every
 *  caller that accepts caller-supplied captures (webhook-fire, relay-fire). */
export function sanitizeCaptures(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
  // Clamp to KV's per-value limit at this shared chokepoint so NO path (cron,
  // webhook, or future) can persist an over-limit row that throws on save and
  // gets silently dropped.
  const runResultDto = clampRunRowToKvLimit(runResult.toDto(), tag);
  // Persist the run, but DON'T let a save failure (e.g. an over-limit KV value)
  // silently swallow the alert for a FAILING check — that would be a monitoring
  // blackout exactly when it matters. The clamp above keeps the value under KV's
  // limit, but as defense-in-depth we still proceed to the alert path on a save
  // error rather than aborting the whole function.
  try {
    await runResult.save(runResultDto);
    // Log the exact key (runId + timestamp) so a row can be purged manually from
    // the Reports tab even in the unlikely event it ever becomes unreadable.
    log.info(`✅ ${tag}: saved runId=${runResultDto.runId} at=${runResultDto.timestamp}`);
  } catch (e) {
    log.error(`❌ ${tag}: run persist failed — continuing to alert so a failing check still pages: ${(e as Error).message}`);
  }

  const isRecovery = previousRun !== null && !previousRun.passed && input.passed;
  // Alert on ANY failure (down endpoint, non-2xx, timeout, extraction failure,
  // or threshold breach), and on recovery when the monitor opts in. A
  // suppressed run (e.g. integration setup verification) persists but never
  // dispatches, so a not-yet-wired endpoint can't page everyone at create time.
  const shouldAlert = !input.suppressAlert && (!input.passed || (isRecovery && input.notifyOnRecover));
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
  const channel = AlertChannel.fromAlert(effectiveAlert);
  // Report the channels actually built (known channels only) — NOT the raw
  // recipient list — so an alert composed entirely of unknown channels can't
  // claim fired:true with a phantom channel list while delivering nothing.
  const channels = channel.dispatchedLabels();
  if (channels.length === 0) {
    log.warn(`⚠️ ${tag}: alert configured for ${input.monitorId} but no deliverable channels (all recipients had unknown channel) — skipping`);
    return { runResult: runResultDto, fired: false, channels: [] };
  }

  try {
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
