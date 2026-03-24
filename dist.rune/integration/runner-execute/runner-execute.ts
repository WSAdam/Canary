import type { MonitorIdDto } from "../../dto/monitor-id-dto.ts";
import type { RunResultDto } from "../../dto/run-result-dto.ts";
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
    console.log(`🔍 runner.execute: response received — status=${responseDto.status} bodyLength=${JSON.stringify(responseDto.body ?? "").length}`);
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
    try {
      const alert = new Alert();
      const alertDto = await alert.get(input.monitorId);
      console.log(`🔍 runner.execute: alert config loaded, recipients=${alertDto.recipients.length}`);
      const alertChannel = AlertChannel.fromAlert(alertDto);
      console.log(`🔍 runner.execute: sending alert via channel`);
      await alertChannel.send(runResultDto);
      console.log(`✅ runner.execute: alert sent successfully`);
    } catch (e) {
      console.log(`⚠️ runner.execute: alert failed (non-fatal) — ${(e as Error).message}`, (e as Error).stack);
    }
  } else {
    console.log(`🔍 runner.execute: no alert needed`);
  }

  console.log(`✅ runner.execute: complete for monitorId=${input.monitorId} passed=${passed} observed=${observed}`);
  return runResultDto;
}
