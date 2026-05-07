import type { MonitorIdDto } from "../../dto/monitor-id-dto.ts";
import type { RunResultDto } from "../../dto/run-result-dto.ts";
import type { AlertDto } from "../../dto/alert-dto.ts";
import { Monitor } from "../../impure/monitor/monitor.ts";
import { Check } from "../../impure/check/check.ts";
import { Alert } from "../../impure/alert/alert.ts";
import { Source } from "../../impure/source/mod.ts";
import { Extractor } from "../../pure/extractor/extractor.ts";
import { Comparator } from "../../pure/comparator/comparator.ts";
import { RunResult } from "../../impure/runResult/runResult.ts";
import { AlertChannel } from "../../impure/alertChannel/mod.ts";

export async function executeRunner(input: MonitorIdDto): Promise<RunResultDto> {
  console.log(`🚀 runner.execute: starting for monitorId=${input.monitorId}`);

  // Load check config (required)
  const check = new Check();
  console.log(`🔍 runner.execute: loading check config for monitorId=${input.monitorId}`);
  const checkDto = await check.get(input.monitorId);
  console.log(`✅ runner.execute: check loaded — url=${checkDto.url} cron=${checkDto.cron} method=${checkDto.method}`);

  // Load monitor name for human-readable alerts (optional — don't fail if missing)
  let monitorName: string | undefined;
  try {
    const monitor = new Monitor();
    console.log(`🔍 runner.execute: loading monitor name for monitorId=${input.monitorId}`);
    const monitorDto = await monitor.get(input.monitorId);
    monitorName = monitorDto.name;
    console.log(`✅ runner.execute: monitor name="${monitorName}"`);
  } catch {
    console.log(`⚠️ runner.execute: could not load monitor name for ${input.monitorId}`);
  }

  // Fetch previous run for recovery detection
  console.log(`🔍 runner.execute: fetching previous run result for monitorId=${input.monitorId}`);
  const previousRun = await RunResult.getLatest(input.monitorId);
  console.log(`🔍 runner.execute: previousRun=${previousRun === null ? "null (no prior run)" : `passed=${previousRun.passed} observed=${previousRun.observed} timestamp=${previousRun.timestamp}`}`);

  // Run the check — treat fetch/parse errors as a failed run (not a crash)
  let observed = 0;
  let passed = false;
  let runError: string | undefined;
  let captures: Record<string, string> | undefined;
  try {
    console.log(`🔍 runner.execute: building source from check config`);
    const source = Source.fromCheck(checkDto);
    console.log(`🔍 runner.execute: fetching ${checkDto.method} ${checkDto.url}`);
    const responseDto = await source.fetch(checkDto);
    console.log(`🔍 runner.execute: response received — payloadLength=${responseDto.payload?.length ?? 0}`);
    observed = Extractor.apply(checkDto, responseDto);
    console.log(`🔍 runner.execute: extractor applied — observed=${observed}`);
    passed = Comparator.evaluate(checkDto, observed);
    console.log(`🔍 runner.execute: comparator evaluated — observed=${observed} passed=${passed}`);
    if (checkDto.captures && Object.keys(checkDto.captures).length > 0) {
      captures = Extractor.applyCaptures(checkDto.captures, responseDto.payload);
      console.log(`🔍 runner.execute: captures extracted — ${JSON.stringify(captures)}`);
    }
  } catch (e) {
    runError = (e as Error).message;
    console.log(`❌ runner.execute: check failed — ${runError}`, (e as Error).stack);
  }

  // Build and persist result
  console.log(`🔍 runner.execute: building run result — observed=${observed} passed=${passed} error=${runError ?? "none"}`);
  const runResult = RunResult.build(input.monitorId, observed, passed, monitorName, runError, captures);
  const runResultDto = runResult.toDto();
  console.log(`🔍 runner.execute: saving run result runId=${runResultDto.runId}`);
  await runResult.save(runResultDto);
  console.log(`✅ runner.execute: run result saved runId=${runResultDto.runId}`);

  // Alert if needed (optional — skip if no alert configured)
  // Don't alert on HTTP/network errors — only on actual data comparison failures
  const isRecovery = previousRun !== null && !previousRun.passed && passed;
  const shouldAlert = !runError && (!passed || (isRecovery && checkDto.notifyOnRecover));
  console.log(`🔍 runner.execute: alert check — passed=${passed} runError=${runError ?? "none"} isRecovery=${isRecovery} notifyOnRecover=${checkDto.notifyOnRecover} shouldAlert=${shouldAlert}`);

  if (shouldAlert) {
    console.log(`⚠️ runner.execute: alerting — reason=${passed ? "recovery" : "failure"}`);
    let alertDto: AlertDto | null = null;
    try {
      const alert = new Alert();
      alertDto = await alert.get(input.monitorId);
      console.log(`🔍 runner.execute: alert config loaded, recipients=${alertDto.recipients.length}`);
    } catch (e) {
      const err = e as Error & { fault?: string };
      if (err.fault === "not-found") {
        console.log(`⚠️ runner.execute: no alert configured for monitor ${input.monitorId} — skipping (configure via POST /monitors/${input.monitorId}/alert)`);
      } else {
        console.log(`⚠️ runner.execute: alert config load failed (non-fatal) — ${err.message}`, err.stack);
      }
    }

    if (alertDto && alertDto.recipients.length === 0) {
      console.log(`⚠️ runner.execute: alert configured for ${input.monitorId} but recipients=[] — skipping`);
    } else if (alertDto) {
      try {
        const alertChannel = AlertChannel.fromAlert(alertDto);
        console.log(`🔍 runner.execute: dispatching alert to ${alertDto.recipients.length} recipient(s) — channels=[${alertDto.recipients.map((r) => r.channel).join(", ")}]`);
        await alertChannel.send(runResultDto);
        console.log(`✅ runner.execute: alert sent successfully`);
      } catch (e) {
        const err = e as Error;
        console.log(`❌ runner.execute: alert dispatch failed (non-fatal) — ${err.message}`, err.stack);
      }
    }
  } else {
    console.log(`🔍 runner.execute: no alert needed`);
  }

  console.log(`✅ runner.execute: complete for monitorId=${input.monitorId} passed=${passed} observed=${observed}`);
  return runResultDto;
}
