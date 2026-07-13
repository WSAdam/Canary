import type { ConfigureCheckDto } from "../../dto/configure-check-dto.ts";
import type { CheckDto } from "../../dto/check-dto.ts";
import { Check } from "../../impure/check/check.ts";
import { Monitor } from "../../impure/monitor/monitor.ts";
import { Schedule } from "../../pure/schedule/schedule.ts";
import { CanaryError, requireString } from "../../dto/_shared.ts";
import { log } from "../../impure/_log.ts";

// The comparator's known operators — mirrored from Comparator.evaluate. Checked
// at configure time so a typo (e.g. "greater") is rejected with a 400 here
// instead of silently 200'ing and then failing+alerting on every cron run.
const COMPARATOR_OPS = new Set(["lt", "gt", "lte", "gte", "eq"]);

// A logs link is displayed in alerts and appended to SMS bodies; bound its
// length so a pathological value can't (a) split one SMS into dozens of billed
// segments per run, nor (b) push the stored CheckDto past Deno KV's ~64KiB
// per-value limit (which would throw an opaque 500 instead of a clean 400).
// 2048 comfortably fits any real dashboard/log URL.
const MAX_LOGS_URL_LEN = 2048;

/** Validate an optional logsUrl: must be a string and, when non-empty, a real
 *  http(s) URL (it becomes a clickable link in alerts). Returns the URL in its
 *  NORMALIZED form (`parsed.href` — percent-encodes any stray CR/LF/TAB the URL
 *  parser tolerates, so the stored value is guaranteed a clean single-line
 *  URL), or undefined when omitted/blank. Rejects other schemes so a
 *  `javascript:`/`data:` link can't ride into an alert, and over-long input. */
export function normalizeLogsUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new CanaryError("validation-error", "logsUrl must be a string", 400);
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_LOGS_URL_LEN) {
    throw new CanaryError("validation-error", `logsUrl must be at most ${MAX_LOGS_URL_LEN} characters`, 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CanaryError("validation-error", `logsUrl "${value}" is not a valid URL`, 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CanaryError("validation-error", "logsUrl must be an http(s) URL", 400);
  }
  // Store the parser's canonical form, not the raw input, so control characters
  // the URL constructor silently strips can't survive into the persisted value.
  return parsed.href;
}

/** Assert a value is a plain object whose every value is a string (the shape of
 *  both `headers` and `captures`), throwing a uniform 400 otherwise. */
function assertStringRecord(value: unknown, field: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CanaryError("validation-error", `${field} must be an object of string values`, 400);
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new CanaryError("validation-error", `${field} must be an object of string values`, 400);
    }
  }
}

export async function configureCheck(input: ConfigureCheckDto): Promise<CheckDto> {
  log.debug("🚀 check.configure", input.monitorId);
  // Reject orphan checks: a check for a non-existent monitor would still be
  // executed by the cron tick and alert on a monitor the UI doesn't list.
  await new Monitor().get(input.monitorId); // throws not-found
  // Validate required string fields up front so a missing/non-string cron,
  // url, expression, or comparatorOp surfaces as a clean 400 rather than a raw
  // TypeError (cron.trim()) or a run-time failure (bad comparatorOp).
  requireString(input.cron, "cron");
  requireString(input.url, "url");
  requireString(input.method, "method");
  requireString(input.expression, "expression");
  requireString(input.comparatorOp, "comparatorOp");
  if (!COMPARATOR_OPS.has(input.comparatorOp)) {
    throw new CanaryError(
      "validation-error",
      `Unknown comparatorOp "${input.comparatorOp}" — expected lt, gt, lte, gte, or eq`,
      400,
    );
  }
  if (typeof input.threshold !== "number" || Number.isNaN(input.threshold)) {
    throw new CanaryError("validation-error", "threshold is required and must be a number", 400);
  }
  // Validate the structured fields too. Without this a direct caller can store
  // headers as a string/array, body as a number, or captures as a non-object;
  // they pass configure (200) but make every run error at fetch/resolve time —
  // a check stuck permanently failing with no validation feedback. Reject the
  // bad shape as a 400 at the boundary instead.
  assertStringRecord(input.headers, "headers");
  if (input.captures !== undefined) assertStringRecord(input.captures, "captures");
  if (input.body !== undefined && typeof input.body !== "string") {
    throw new CanaryError("validation-error", "body must be a string", 400);
  }
  if (input.notifyOnSuccess !== undefined && typeof input.notifyOnSuccess !== "boolean") {
    throw new CanaryError("validation-error", "notifyOnSuccess must be a boolean", 400);
  }
  // logsUrl is optional; when present it must be a real http(s) URL (it's shown
  // as a clickable link in alert emails). An empty string normalizes to "unset".
  const logsUrl = normalizeLogsUrl(input.logsUrl);
  Schedule.validate(input);           // throws invalid-cron if cron is malformed
  // Normalize the two new fields into the stored dto so a check row always
  // carries a boolean notifyOnSuccess and a trimmed/absent logsUrl.
  const check = Check.build({ ...input, notifyOnSuccess: input.notifyOnSuccess === true, logsUrl });
  const checkDto = check.toDto();
  const result = await check.upsert(checkDto);
  log.debug("✅ check.configure", result.monitorId, result.cron);
  return result;
}
