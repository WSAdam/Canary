import type { MonitorIdDto } from "../../dto/monitor-id-dto.ts";
import type { RunResultDto, RunRequestDetailDto, RunResponseDetailDto } from "../../dto/run-result-dto.ts";
import type { CheckDto } from "../../dto/check-dto.ts";
import { Monitor } from "../../impure/monitor/monitor.ts";
import { Check } from "../../impure/check/check.ts";
import { Secret } from "../../impure/secret/secret.ts";
import { Source } from "../../impure/source/mod.ts";
import { Extractor } from "../../pure/extractor/extractor.ts";
import { Comparator } from "../../pure/comparator/comparator.ts";
import { persistRunAndAlert } from "../_shared/persistRunAndAlert.ts";
import { CanaryError, type ResponseDetailCarrier } from "../../dto/_shared.ts";
import { log, withRun } from "../../impure/_log.ts";

// {{KEY}} secret references, substituted into the outbound request just before
// it is sent. Whitespace around the key is tolerated.
const SECRET_RE = /\{\{\s*([^}\s]+)\s*\}\}/g;

// Cap persisted response bodies so a single chatty endpoint can't blow past the
// Deno KV per-value limit or bloat the run history.
const MAX_RESPONSE_BODY = 16 * 1024;

// Header names whose values must never be persisted or logged in the clear.
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "x-api-key", "proxy-authorization"]);

/**
 * Mask the values of known-sensitive headers (e.g. a literal Authorization
 * bearer) before they are persisted to a run detail or written to a log.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? "***" : v;
  }
  return out;
}

function truncateBody(body: string): { body: string; truncated: boolean } {
  if (body.length <= MAX_RESPONSE_BODY) return { body, truncated: false };
  return { body: body.slice(0, MAX_RESPONSE_BODY) + "…(truncated)", truncated: true };
}

/**
 * Replace {{KEY}} tokens in the check's url, header values, and body with the
 * stored secret values. Works on a COPY — the template is never mutated, so
 * logs and run results keep showing {{KEY}}, not the value. Returns the
 * resolved values so the caller can redact them from any error text.
 */
export async function resolveCheckSecrets(check: CheckDto): Promise<{ check: CheckDto; secretValues: string[] }> {
  const fields = [check.url, check.body ?? "", ...Object.values(check.headers ?? {})];
  const keys = new Set<string>();
  for (const field of fields) {
    for (const m of field.matchAll(SECRET_RE)) keys.add(m[1]);
  }
  if (keys.size === 0) return { check, secretValues: [] };

  const secret = new Secret();
  const values = new Map<string, string>();
  for (const key of keys) {
    try {
      values.set(key, await secret.resolve(key));
    } catch {
      // Name the missing key, never a value.
      throw new CanaryError("secret-not-found", `Check references secret "${key}" which is not configured`, 400);
    }
  }
  const sub = (s: string) => s.replace(SECRET_RE, (m, k) => values.get(k) ?? m);
  const resolved: CheckDto = {
    ...check,
    url: sub(check.url),
    body: check.body !== undefined ? sub(check.body) : undefined,
    headers: Object.fromEntries(Object.entries(check.headers ?? {}).map(([k, v]) => [k, sub(v)])),
  };
  return { check: resolved, secretValues: [...values.values()] };
}

export function redactSecrets(text: string, secretValues: string[]): string {
  let out = text;
  for (const v of secretValues) {
    if (v) out = out.split(v).join("***");
  }
  return out;
}

export function executeRunner(input: MonitorIdDto): Promise<RunResultDto> {
  // One id for the whole run: it tags every log line below (via withRun) AND
  // becomes the stored run's runId, so logs and history line up exactly.
  const runId = crypto.randomUUID();
  return withRun(runId, () => executeRun(runId, input));
}

async function executeRun(runId: string, input: MonitorIdDto): Promise<RunResultDto> {
  log.info(`🚀 runner.execute: starting for monitorId=${input.monitorId}`);

  const check = new Check();
  log.debug(`🔍 runner.execute: loading check config for monitorId=${input.monitorId}`);
  const checkDto = await check.get(input.monitorId);
  log.info(`✅ runner.execute: check loaded — url=${checkDto.url} cron=${checkDto.cron} method=${checkDto.method}`);

  let monitorName: string | undefined;
  try {
    const monitor = new Monitor();
    const monitorDto = await monitor.get(input.monitorId);
    monitorName = monitorDto.name;
    log.debug(`✅ runner.execute: monitor name="${monitorName}"`);
  } catch {
    log.warn(`⚠️ runner.execute: could not load monitor name for ${input.monitorId}`);
  }

  let observed = 0;
  let passed = false;
  let runError: string | undefined;
  let captures: Record<string, string> | undefined;
  let secretValues: string[] = [];
  // Captured for the failed-run drill-in. Populated from the successful response
  // OR from a non-2xx error that carries the upstream status/body.
  let responseStatus: number | undefined;
  let responseBody: string | undefined;
  try {
    const resolved = await resolveCheckSecrets(checkDto);
    secretValues = resolved.secretValues;
    const source = Source.fromCheck(resolved.check);
    // Log the TEMPLATE url (checkDto), not the resolved one, so secrets stay out of logs.
    log.info(`🔍 runner.execute: fetching ${checkDto.method} ${checkDto.url}`);
    // Pass resolved values so the source can scrub them from its own logs/errors.
    const responseDto = await source.fetch(resolved.check, secretValues);
    responseStatus = responseDto.status;
    responseBody = responseDto.payload;
    log.debug(`🔍 runner.execute: response received — status=${responseDto.status ?? "?"} payloadLength=${responseDto.payload?.length ?? 0}`);
    observed = Extractor.apply(checkDto, responseDto);
    log.info(`🔍 runner.execute: extractor applied — observed=${observed}`);
    passed = Comparator.evaluate(checkDto, observed);
    log.debug(`🔍 runner.execute: comparator evaluated — observed=${observed} passed=${passed} op=${checkDto.comparatorOp} threshold=${checkDto.threshold}`);
    if (checkDto.captures && Object.keys(checkDto.captures).length > 0) {
      captures = Extractor.applyCaptures(checkDto.captures, responseDto.payload);
      log.debug(`🔍 runner.execute: captures extracted — ${JSON.stringify(captures)}`);
    }
  } catch (e) {
    // Redact any resolved secret values that may appear in the error text
    // before it is persisted to the run result or surfaced in an alert.
    runError = redactSecrets((e as Error).message, secretValues);
    // A non-2xx response throws but carries the upstream status/body so the
    // failed-run drill-in can still show what the endpoint returned.
    const carrier = e as ResponseDetailCarrier;
    if (carrier.responseStatus !== undefined) responseStatus = carrier.responseStatus;
    if (carrier.responseBody !== undefined) responseBody = carrier.responseBody;
    log.error(`❌ runner.execute: check failed — ${runError}`);
  }

  // Capture request/response on FAILED runs only — that is what gets debugged,
  // and it keeps passing-run history lean.
  let request: RunRequestDetailDto | undefined;
  let response: RunResponseDetailDto | undefined;
  if (!passed) {
    request = {
      method: checkDto.method,
      url: checkDto.url, // template — keeps {{KEY}} out of band, never the secret value
      headers: redactHeaders(checkDto.headers),
      body: checkDto.body,
    };
    if (responseStatus !== undefined || responseBody !== undefined) {
      const t = truncateBody(redactSecrets(responseBody ?? "", secretValues));
      response = {
        status: responseStatus,
        body: responseBody !== undefined ? t.body : undefined,
        truncated: t.truncated || undefined,
      };
    }
  }

  const { runResult } = await persistRunAndAlert({
    runId,
    monitorId: input.monitorId,
    monitorName,
    observed,
    passed,
    error: runError,
    captures,
    request,
    response,
    notifyOnRecover: checkDto.notifyOnRecover,
    source: "cron",
  });

  log.info(`✅ runner.execute: complete for monitorId=${input.monitorId} passed=${passed} observed=${observed}`);
  return runResult;
}
