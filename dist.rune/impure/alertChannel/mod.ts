import type { AlertDto } from "../../dto/alert-dto.ts";
import type { RunResultDto } from "../../dto/run-result-dto.ts";
import { CanaryError } from "../../dto/_shared.ts";
import { BaseAlertChannel } from "./shared/mod.ts";
import { Sms } from "./implementations/sms/mod.ts";
import { Email } from "./implementations/email/mod.ts";
import { Ntfy } from "./implementations/ntfy/mod.ts";

export class AlertChannel {
  private constructor(
    private readonly channels: BaseAlertChannel[],
    private readonly labels: string[],
    private readonly alert: AlertDto,
  ) {}

  static fromAlert(dto: AlertDto): AlertChannel {
    const channels: BaseAlertChannel[] = [];
    const labels: string[] = [];
    for (const r of dto.recipients) {
      if (r.channel === "sms") { channels.push(new Sms(r.address)); labels.push("sms"); }
      else if (r.channel === "email") { channels.push(new Email(r.address)); labels.push("email"); }
      else if (r.channel === "ntfy") { channels.push(new Ntfy(r.address)); labels.push("ntfy"); }
      // Skip an unknown channel rather than throwing — a single bad recipient
      // must not block the valid ones from being notified.
      else console.log(`⚠️ AlertChannel.fromAlert: skipping unknown channel "${r.channel}"`);
    }
    return new AlertChannel(channels, labels, dto);
  }

  async send(run: RunResultDto): Promise<void> {
    // allSettled, not all: one channel's failure (e.g. a bad ntfy address) must
    // never suppress the others. We attempt every channel, then report.
    const results = await Promise.allSettled(this.channels.map((c) => c.send(run, this.alert)));
    results.forEach((res, i) => {
      const label = this.labels[i] ?? "channel";
      if (res.status === "rejected") {
        const reason = res.reason instanceof Error ? res.reason.message : String(res.reason);
        console.log(`❌ AlertChannel.send: ${label} failed (non-fatal) — ${reason}`);
      } else {
        console.log(`✅ AlertChannel.send: ${label} sent`);
      }
    });
    const failed = results.filter((r) => r.status === "rejected").length;
    // Only surface an error when EVERY channel failed — a partial success still
    // counts as fired (the good channels were notified).
    if (this.channels.length > 0 && failed === this.channels.length) {
      throw new CanaryError("send-failed", `All ${this.channels.length} alert channel(s) failed`, 502);
    }
  }
}
