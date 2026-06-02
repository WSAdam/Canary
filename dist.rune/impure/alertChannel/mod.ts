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
    const channels: BaseAlertChannel[] = [];
    for (const r of dto.recipients) {
      if (r.channel === "sms") channels.push(new Sms(r.address));
      else if (r.channel === "email") channels.push(new Email(r.address));
      else if (r.channel === "ntfy") channels.push(new Ntfy(r.address));
      // Skip an unknown channel rather than throwing — a single bad recipient
      // must not block the valid ones from being notified.
      else console.log(`⚠️ AlertChannel.fromAlert: skipping unknown channel "${r.channel}"`);
    }
    return new AlertChannel(channels, dto);
  }

  async send(run: RunResultDto): Promise<void> {
    await Promise.all(this.channels.map((c) => c.send(run, this.alert)));
  }
}
