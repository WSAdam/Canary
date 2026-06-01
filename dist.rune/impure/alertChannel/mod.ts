import type { AlertDto } from "../../dto/alert-dto.ts";
import type { RunResultDto } from "../../dto/run-result-dto.ts";
import { BaseAlertChannel } from "./shared/mod.ts";
import { Sms } from "./implementations/sms/mod.ts";
import { Email } from "./implementations/email/mod.ts";
import { Ntfy } from "./implementations/ntfy/mod.ts";

export class AlertChannel {
  private constructor(
    private readonly channels: BaseAlertChannel[],
    private readonly alert: AlertDto,
  ) {}

  static fromAlert(dto: AlertDto): AlertChannel {
    const channels = dto.recipients.map((r) => {
      if (r.channel === "sms") return new Sms(r.address);
      if (r.channel === "email") return new Email(r.address);
      if (r.channel === "ntfy") return new Ntfy(r.address);
      throw new Error(`Unknown channel: "${r.channel}" — expected "sms", "email", or "ntfy"`);
    });
    return new AlertChannel(channels, dto);
  }

  async send(run: RunResultDto): Promise<void> {
    await Promise.all(this.channels.map((c) => c.send(run, this.alert)));
  }
}
