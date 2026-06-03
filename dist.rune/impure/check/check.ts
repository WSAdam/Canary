import { kv } from "../_kv.ts";
import type { ConfigureCheckDto } from "../../dto/configure-check-dto.ts";
import type { CheckDto } from "../../dto/check-dto.ts";
import { CanaryError } from "../../dto/_shared.ts";
import { log } from "../_log.ts";

export class Check {
  private data?: CheckDto;

  static build(dto: ConfigureCheckDto): Check {
    log.debug(`🔍 check.build: monitorId=${dto.monitorId} url=${dto.url} cron=${dto.cron}`);
    const check = new Check();
    check.data = { ...dto };
    return check;
  }

  toDto(): CheckDto {
    if (!this.data) throw new Error("Check not initialized — call Check.build() first");
    return this.data;
  }

  async upsert(dto: CheckDto): Promise<CheckDto> {
    log.debug(`🚀 check.upsert: key=["check", "${dto.monitorId}"]`);
    await kv.set(["check", dto.monitorId], dto);
    const verify = await kv.get<CheckDto>(["check", dto.monitorId], { consistency: "strong" });
    if (verify.value === null) {
      log.error(`❌ check.upsert: READ-BACK FAILED — write did not persist!`);
    } else {
      log.debug(`✅ check.upsert: verified check for ${dto.monitorId} url=${verify.value.url}`);
    }
    return dto;
  }

  async get(monitorId: string): Promise<CheckDto> {
    log.debug(`🔍 check.get: key=["check", "${monitorId}"] consistency=strong`);
    const result = await kv.get<CheckDto>(["check", monitorId], { consistency: "strong" });
    if (result.value === null) {
      log.debug(`❌ check.get: NOT FOUND for monitorId=${monitorId}`);
      throw new CanaryError("not-found", `Check config for monitor "${monitorId}" not found`, 404);
    }
    log.debug(`✅ check.get: found check url=${result.value.url} cron=${result.value.cron} versionstamp=${result.versionstamp}`);
    return result.value;
  }
}
