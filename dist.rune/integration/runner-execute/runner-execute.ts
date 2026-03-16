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

  // Load configs
  const monitor = new Monitor();
  await monitor.get(input.monitorId); // throws not-found if monitor missing

  const check = new Check();
  const checkDto = await check.get(input.monitorId); // throws not-found if check missing

  const alert = new Alert();
  const alertDto = await alert.get(input.monitorId); // throws not-found if alert missing

  // Fetch the previous run result BEFORE saving the new one (for recovery detection)
  const previousRun = await RunResult.getLatest(input.monitorId);

  // Fetch source, extract value, evaluate comparator
  const source = Source.fromCheck(checkDto);
  const responseDto = await source.fetch(checkDto);

  const observed = Extractor.apply(checkDto, responseDto);
  const passed = Comparator.evaluate(checkDto, observed);

  // Build, persist, and return result
  const runResult = RunResult.build(input.monitorId, observed, passed);
  const runResultDto = runResult.toDto();
  await runResult.save(runResultDto);

  // Alert logic:
  //   - always alert on failure
  //   - alert on recovery (was failing, now passing) only if notifyOnRecover is set
  const isRecovery = previousRun !== null && !previousRun.passed && passed;
  const shouldAlert = !passed || (isRecovery && checkDto.notifyOnRecover);

  if (shouldAlert) {
    console.log("⚠️ runner.execute alerting —", passed ? "recovery" : "failure");
    const alertChannel = AlertChannel.fromAlert(alertDto);
    await alertChannel.send(runResultDto);
  }

  console.log("✅ runner.execute", input.monitorId, "passed:", passed, "observed:", observed);
  return runResultDto;
}
