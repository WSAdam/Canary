import { kv } from "../_kv.ts";
import type { ConfigureAlertDto } from "../../dto/configure-alert-dto.ts";
import type { AlertDto } from "../../dto/alert-dto.ts";
import { CanaryError } from "../../dto/_shared.ts";

export class Alert {
  private data?: AlertDto;

  static build(dto: ConfigureAlertDto): Alert {
    const alert = new Alert();
    alert.data = { monitorId: dto.monitorId, recipients: dto.recipients };
    return alert;
  }

  toDto(): AlertDto {
    if (!this.data) throw new Error("Alert not initialized — call Alert.build() first");
    return this.data;
  }

  async upsert(dto: AlertDto): Promise<AlertDto> {
    await kv.set(["alert", dto.monitorId], dto);
    return dto;
  }

  async get(monitorId: string): Promise<AlertDto> {
    const result = await kv.get<AlertDto>(["alert", monitorId]);
    if (result.value === null) {
      throw new CanaryError("not-found", `Alert config for monitor "${monitorId}" not found`, 404);
    }
    return result.value;
  }
}
