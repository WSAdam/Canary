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
  Schedule.validate(input);           // throws invalid-cron if cron is malformed
  const check = Check.build(input);
  const checkDto = check.toDto();
  const result = await check.upsert(checkDto);
  log.debug("✅ check.configure", result.monitorId, result.cron);
  return result;
}
