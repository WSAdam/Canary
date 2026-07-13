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

// Cap the NUMBER of persisted captures as a coarse first bound...
const MAX_CAPTURES = 32;

// ...but the real guard is on aggregate BYTES. Deno KV rejects an atomic value
// over ~64KB by THROWING, and the whole RunResultDto (captures + request body +
// response body + error) is one KV value. Counting captures alone is
// mathematically insufficient — 32 × 16KB ≫ 64KB, and as few as ~5 near-16KB
// captures already blow the cap — so we accumulate the serialized size of the
// captures map and stop adding once it would exceed this budget. Sized so the
// WORST-CASE row stays under 64KB even when every part is maxed: captures (16KB)
// + truncated request body (≤16KB) + truncated response body (≤16KB) + error
// (≤2KB) + ids/url/headers ≈ 50KB + headroom — so the save never throws and
// silently drops the run (and, for a failing check, its alert).
const MAX_CAPTURES_TOTAL_BYTES = 16 * 1024;

// Cap the persisted failure error message. It can embed the full (uncapped)
// check URL, so on its own it must not be able to push the row past KV's limit.
const MAX_ERROR_BYTES = 2 * 1024;

// The persisted failed-run request detail echoes the check's url + headers, both
// user-controlled and otherwise unbounded. Cap them too, or a large check could
// push the run row past KV's per-value limit and silently drop the whole run.
const MAX_REQUEST_URL_BYTES = 2 * 1024;
const MAX_REQUEST_HEADERS_BYTES = 4 * 1024;

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

/**
 * Bound the persisted request headers to a UTF-8 byte budget (they are
 * user-controlled and otherwise unbounded), dropping any beyond the budget so
 * the run row can't exceed KV's per-value limit and be silently dropped.
 */
export function capHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  let used = 0;
  for (const [k, v] of Object.entries(headers ?? {})) {
    used += byteLen(k) + byteLen(v) + 6; // rough JSON punctuation ("":"",)
    if (used > MAX_REQUEST_HEADERS_BYTES) break;
    out[k] = v;
  }
  return out;
}

const _enc = new TextEncoder();
const _dec = new TextDecoder();

/** UTF-8 byte length of a string (NOT its UTF-16 code-unit .length). */
export function byteLen(s: string): number {
  return _enc.encode(s).length;
}

// Truncate to a UTF-8 BYTE budget. Deno KV's per-value limit is on serialized
// bytes, not JS string length — multi-byte content (CJK ≈ 3×, emoji ≈ 2× its
// code-unit count) would otherwise pass a .length check and still overflow the
// row, throwing on save and silently dropping the whole run. Slices on a byte
// boundary and drops any trailing partial sequence so the result stays valid.
export function truncateBody(body: string, maxBytes = MAX_RESPONSE_BODY): { body: string; truncated: boolean } {
  const bytes = _enc.encode(body);
  if (bytes.length <= maxBytes) return { body, truncated: false };
  const head = _dec.decode(bytes.subarray(0, maxBytes)).replace(/�$/, "");
  return { body: head + "…(truncated)", truncated: true };
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

export interface ExecuteRunnerOptions {
  // Persist the run but do NOT dispatch any alert. Used by the integration
  // verification run so a not-yet-wired endpoint can't page every recipient
  // before the integration is confirmed working.
  suppressAlert?: boolean;
}

export function executeRunner(input: MonitorIdDto, options?: ExecuteRunnerOptions): Promise<RunResultDto> {
  // One id for the whole run: it tags every log line below (via withRun) AND
  // becomes the stored run's runId, so logs and history line up exactly.
  const runId = crypto.randomUUID();
  return withRun(runId, () => executeRun(runId, input, options));
}

async function executeRun(runId: string, input: MonitorIdDto, options?: ExecuteRunnerOptions): Promise<RunResultDto> {
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
      const rawCaptures = Extractor.applyCaptures(checkDto.captures, responseDto.payload);
      // Capture values are persisted to KV, rendered in the Reports drill-in, and
      // spread into alert template vars — so they must be (1) redacted of any
      // resolved {{SECRET}} the endpoint might echo back (mirrors the responseBody
      // handling) and (2) size-capped so a large capture can't push the run row
      // past KV's per-value limit and fail the atomic save.
      captures = {};
      // Bound BOTH the count and the aggregate serialized bytes so the run row
      // can't exceed KV's per-value limit and fail the atomic save (which would
      // drop the whole run + its alert). Each value is individually truncated to
      // MAX_RESPONSE_BODY, then we stop once the cumulative size would exceed
      // MAX_CAPTURES_TOTAL_BYTES.
      let capturesBytes = 0;
      for (const [name, value] of Object.entries(rawCaptures).slice(0, MAX_CAPTURES)) {
        const v = truncateBody(redactSecrets(value, secretValues)).body;
        // Account for the key + value + JSON punctuation via the serialized
        // UTF-8 BYTE size of this entry (not its UTF-16 code-unit length).
        const entryBytes = byteLen(JSON.stringify({ [name]: v }));
        if (capturesBytes + entryBytes > MAX_CAPTURES_TOTAL_BYTES) break;
        capturesBytes += entryBytes;
        captures[name] = v;
      }
      const droppedCaptures = Object.keys(rawCaptures).length - Object.keys(captures).length;
      if (droppedCaptures > 0) {
        log.warn(`⚠️ runner.execute: dropped ${droppedCaptures} capture(s) over the persist cap (count ${MAX_CAPTURES} / ${MAX_CAPTURES_TOTAL_BYTES} bytes)`);
      }
      log.debug(`🔍 runner.execute: captures extracted — ${Object.keys(captures).length} value(s)`);
    }
  } catch (e) {
    // Redact any resolved secret values that may appear in the error text
    // before it is persisted to the run result or surfaced in an alert, and cap
    // its byte size — the message can embed the full check URL, which must not
    // be able to push the run row past KV's per-value limit on every failure.
    runError = truncateBody(redactSecrets((e as Error).message, secretValues), MAX_ERROR_BYTES).body;
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
      // template url — keeps {{KEY}} out of band, never the secret value. Capped
      // (with headers + body below) so a large check can't push the run row past
      // KV's per-value limit and silently drop the whole run.
      url: truncateBody(checkDto.url, MAX_REQUEST_URL_BYTES).body,
      headers: capHeaders(redactHeaders(checkDto.headers)),
      body: checkDto.body !== undefined ? truncateBody(checkDto.body).body : undefined,
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
    // Coerce: a legacy check row predates notifyOnSuccess, so undefined → false.
    notifyOnSuccess: checkDto.notifyOnSuccess === true,
    logsUrl: checkDto.logsUrl,
    source: "cron",
    suppressAlert: options?.suppressAlert,
  });

  log.info(`✅ runner.execute: complete for monitorId=${input.monitorId} passed=${passed} observed=${observed}`);
  return runResult;
}
