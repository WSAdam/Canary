import type { AlertDto } from "../../dto/alert-dto.ts";
import type { RunResultDto } from "../../dto/run-result-dto.ts";
import { BaseAlertChannel } from "./shared/mod.ts";
import { Sms } from "./implementations/sms/mod.ts";
import { Email } from "./implementations/email/mod.ts";

export class AlertChannel {
  private constructor(private readonly channels: BaseAlertChannel[]) {}

  static fromAlert(dto: AlertDto): AlertChannel {
    const channels = dto.recipients.map((r) => {
      if (r.alertType === "sms") return new Sms(r.contact);
      if (r.alertType === "email") return new Email(r.contact);
      throw new Error(`Unknown alertType: "${r.alertType}" — expected "sms" or "email"`);
    });
    return new AlertChannel(channels);
  }

  async send(dto: RunResultDto): Promise<void> {
    await Promise.all(this.channels.map((c) => c.send(dto)));
  }
}
