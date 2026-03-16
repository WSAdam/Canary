import { kv } from "../_kv.ts";
import type { ConfigureCheckDto } from "../../dto/configure-check-dto.ts";
import type { CheckDto } from "../../dto/check-dto.ts";
import { CanaryError } from "../../dto/_shared.ts";

export class Check {
  private data?: CheckDto;

  static build(dto: ConfigureCheckDto): Check {
    const check = new Check();
    check.data = { ...dto };
    return check;
  }

  toDto(): CheckDto {
    if (!this.data) throw new Error("Check not initialized — call Check.build() first");
    return this.data;
  }

  async upsert(dto: CheckDto): Promise<CheckDto> {
    await kv.set(["check", dto.monitorId], dto);
    return dto;
  }

  async get(monitorId: string): Promise<CheckDto> {
    const result = await kv.get<CheckDto>(["check", monitorId]);
    if (result.value === null) {
      throw new CanaryError("not-found", `Check config for monitor "${monitorId}" not found`, 404);
    }
    return result.value;
  }
}
