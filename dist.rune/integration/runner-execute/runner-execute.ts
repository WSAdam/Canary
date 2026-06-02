import type { MonitorIdDto } from "../../dto/monitor-id-dto.ts";
import type { RunResultDto } from "../../dto/run-result-dto.ts";
import type { CheckDto } from "../../dto/check-dto.ts";
import { Monitor } from "../../impure/monitor/monitor.ts";
import { Check } from "../../impure/check/check.ts";
import { Secret } from "../../impure/secret/secret.ts";
import { Source } from "../../impure/source/mod.ts";
import { Extractor } from "../../pure/extractor/extractor.ts";
import { Comparator } from "../../pure/comparator/comparator.ts";
import { persistRunAndAlert } from "../_shared/persistRunAndAlert.ts";
import { CanaryError } from "../../dto/_shared.ts";

// {{KEY}} secret references, substituted into the outbound request just before
// it is sent. Whitespace around the key is tolerated.
const SECRET_RE = /\{\{\s*([^}\s]+)\s*\}\}/g;

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

export async function executeRunner(input: MonitorIdDto): Promise<RunResultDto> {
  console.log(`🚀 runner.execute: starting for monitorId=${input.monitorId}`);

  const check = new Check();
  console.log(`🔍 runner.execute: loading check config for monitorId=${input.monitorId}`);
  const checkDto = await check.get(input.monitorId);
  console.log(`✅ runner.execute: check loaded — url=${checkDto.url} cron=${checkDto.cron} method=${checkDto.method}`);

  let monitorName: string | undefined;
  try {
    const monitor = new Monitor();
    const monitorDto = await monitor.get(input.monitorId);
    monitorName = monitorDto.name;
    console.log(`✅ runner.execute: monitor name="${monitorName}"`);
  } catch {
    console.log(`⚠️ runner.execute: could not load monitor name for ${input.monitorId}`);
  }

  let observed = 0;
  let passed = false;
  let runError: string | undefined;
  let captures: Record<string, string> | undefined;
  let secretValues: string[] = [];
  try {
    const resolved = await resolveCheckSecrets(checkDto);
    secretValues = resolved.secretValues;
    const source = Source.fromCheck(resolved.check);
    // Log the TEMPLATE url (checkDto), not the resolved one, so secrets stay out of logs.
    console.log(`🔍 runner.execute: fetching ${checkDto.method} ${checkDto.url}`);
    // Pass resolved values so the source can scrub them from its own logs/errors.
    const responseDto = await source.fetch(resolved.check, secretValues);
    console.log(`🔍 runner.execute: response received — payloadLength=${responseDto.payload?.length ?? 0}`);
    observed = Extractor.apply(checkDto, responseDto);
    console.log(`🔍 runner.execute: extractor applied — observed=${observed}`);
    passed = Comparator.evaluate(checkDto, observed);
    console.log(`🔍 runner.execute: comparator evaluated — observed=${observed} passed=${passed} op=${checkDto.comparatorOp} threshold=${checkDto.threshold}`);
    if (checkDto.captures && Object.keys(checkDto.captures).length > 0) {
      captures = Extractor.applyCaptures(checkDto.captures, responseDto.payload);
      console.log(`🔍 runner.execute: captures extracted — ${JSON.stringify(captures)}`);
    }
  } catch (e) {
    // Redact any resolved secret values that may appear in the error text
    // before it is persisted to the run result or surfaced in an alert.
    runError = redactSecrets((e as Error).message, secretValues);
    console.log(`❌ runner.execute: check failed — ${runError}`);
  }

  const { runResult } = await persistRunAndAlert({
    monitorId: input.monitorId,
    monitorName,
    observed,
    passed,
    error: runError,
    captures,
    notifyOnRecover: checkDto.notifyOnRecover,
    source: "cron",
  });

  console.log(`✅ runner.execute: complete for monitorId=${input.monitorId} passed=${passed} observed=${observed}`);
  return runResult;
}
