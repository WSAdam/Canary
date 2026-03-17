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
  console.log("🚀 runner.execute", input.monitorId);

  // Load check config (required)
  const check = new Check();
  const checkDto = await check.get(input.monitorId);

  // Load monitor name for human-readable alerts (optional — don't fail if missing)
  let monitorName: string | undefined;
  try {
    const monitor = new Monitor();
    const monitorDto = await monitor.get(input.monitorId);
    monitorName = monitorDto.name;
  } catch {
    console.log(`⚠️ runner.execute: could not load monitor name for ${input.monitorId}`);
  }

  // Fetch previous run for recovery detection
  const previousRun = await RunResult.getLatest(input.monitorId);

  // Run the check — treat fetch/parse errors as a failed run (not a crash)
  let observed = 0;
  let passed = false;
  let runError: string | undefined;
  try {
    const source = Source.fromCheck(checkDto);
    const responseDto = await source.fetch(checkDto);
    observed = Extractor.apply(checkDto, responseDto);
    passed = Comparator.evaluate(checkDto, observed);
    console.log(`🔍 runner.execute: observed=${observed}, passed=${passed}`);
  } catch (e) {
    runError = (e as Error).message;
    console.log(`❌ runner.execute: check failed — ${runError}`);
  }

  // Build and persist result
  const runResult = RunResult.build(input.monitorId, observed, passed, monitorName, runError);
  const runResultDto = runResult.toDto();
  await runResult.save(runResultDto);

  // Alert if needed (optional — skip if no alert configured)
  const isRecovery = previousRun !== null && !previousRun.passed && passed;
  const shouldAlert = !passed || (isRecovery && checkDto.notifyOnRecover);

  if (shouldAlert) {
    console.log("⚠️ runner.execute alerting —", passed ? "recovery" : "failure");
    try {
      const alert = new Alert();
      const alertDto = await alert.get(input.monitorId);
      const alertChannel = AlertChannel.fromAlert(alertDto);
      await alertChannel.send(runResultDto);
      console.log("✅ runner.execute: alert sent");
    } catch (e) {
      console.log(`⚠️ runner.execute: alert failed (non-fatal) — ${(e as Error).message}`);
    }
  }

  console.log("✅ runner.execute complete", input.monitorId, "passed:", passed);
  return runResultDto;
}
