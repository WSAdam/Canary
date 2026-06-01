import type { MonitorIdDto } from "../../dto/monitor-id-dto.ts";
import type { RunResultDto } from "../../dto/run-result-dto.ts";
import { Monitor } from "../../impure/monitor/monitor.ts";
import { Check } from "../../impure/check/check.ts";
import { Source } from "../../impure/source/mod.ts";
import { Extractor } from "../../pure/extractor/extractor.ts";
import { Comparator } from "../../pure/comparator/comparator.ts";
import { persistRunAndAlert } from "../_shared/persistRunAndAlert.ts";

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
  try {
    const source = Source.fromCheck(checkDto);
    console.log(`🔍 runner.execute: fetching ${checkDto.method} ${checkDto.url}`);
    const responseDto = await source.fetch(checkDto);
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
    runError = (e as Error).message;
    console.log(`❌ runner.execute: check failed — ${runError}`, (e as Error).stack);
  }

  const { runResult } = await persistRunAndAlert({
    monitorId: input.monitorId,
    monitorName,
    observed,
    passed,
    error: runError,
    captures,
    notifyOnRecover: checkDto.notifyOnRecover,
    suppressAlertOnError: true,
    source: "cron",
  });

  console.log(`✅ runner.execute: complete for monitorId=${input.monitorId} passed=${passed} observed=${observed}`);
  return runResult;
}
