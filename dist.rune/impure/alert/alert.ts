import { kv } from "../_kv.ts";
import type { ConfigureAlertDto } from "../../dto/configure-alert-dto.ts";
import type { AlertDto } from "../../dto/alert-dto.ts";
import { CanaryError } from "../../dto/_shared.ts";

export class Alert {
  private data?: AlertDto;

  static build(dto: ConfigureAlertDto): Alert {
    console.log(`🔍 alert.build: monitorId=${dto.monitorId} recipients=${dto.recipients.length}`);
    const alert = new Alert();
    alert.data = {
      monitorId: dto.monitorId,
      recipients: dto.recipients,
      emailSubject: dto.emailSubject,
      emailMessage: dto.emailMessage,
      smsMessage: dto.smsMessage,
    };
    return alert;
  }

  toDto(): AlertDto {
    if (!this.data) throw new Error("Alert not initialized — call Alert.build() first");
    return this.data;
  }

  async upsert(dto: AlertDto): Promise<AlertDto> {
    console.log(`🚀 alert.upsert: key=["alert", "${dto.monitorId}"] recipients=${dto.recipients.length}`);
    await kv.set(["alert", dto.monitorId], dto);
    const verify = await kv.get<AlertDto>(["alert", dto.monitorId], { consistency: "strong" });
    if (verify.value === null) {
      console.log(`❌ alert.upsert: READ-BACK FAILED — write did not persist!`);
    } else {
      console.log(`✅ alert.upsert: verified alert for ${dto.monitorId} recipients=${verify.value.recipients.length}`);
    }
    return dto;
  }

  async get(monitorId: string): Promise<AlertDto> {
    console.log(`🔍 alert.get: key=["alert", "${monitorId}"] consistency=strong`);
    const result = await kv.get<AlertDto>(["alert", monitorId], { consistency: "strong" });
    if (result.value === null) {
      console.log(`❌ alert.get: NOT FOUND for monitorId=${monitorId}`);
      throw new CanaryError("not-found", `Alert config for monitor "${monitorId}" not found`, 404);
    }
    console.log(`✅ alert.get: found alert recipients=${result.value.recipients.length} versionstamp=${result.versionstamp}`);
    return result.value;
  }
}
