import type { AlertDto } from "../../dto/alert-dto.ts";
import type { RunResultDto } from "../../dto/run-result-dto.ts";
import { CanaryError } from "../../dto/_shared.ts";
import { BaseAlertChannel } from "./shared/mod.ts";
import { Sms } from "./implementations/sms/mod.ts";
import { Email } from "./implementations/email/mod.ts";
import { Ntfy } from "./implementations/ntfy/mod.ts";
import { log } from "../_log.ts";

// Throttle: space consecutive SMS sends apart so we don't hammer the Zapier
// webhook / carrier when an alert fans out to several numbers.
const SMS_STAGGER_MS = 4000;

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
      else log.warn(`⚠️ AlertChannel.fromAlert: skipping unknown channel "${r.channel}"`);
    }
    return new AlertChannel(channels, labels, dto);
  }

  // The channels actually constructed (known channels only). persistRunAndAlert
  // reports these rather than the raw recipient list, so a recipient with an
  // unknown channel can't make the API claim a notification it never sent.
  dispatchedLabels(): string[] {
    return [...this.labels];
  }

  async send(run: RunResultDto): Promise<void> {
    // allSettled, not all: one channel's failure (e.g. a bad ntfy address) must
    // never suppress the others. We attempt every channel, then report.
    // SMS channels are staggered SMS_STAGGER_MS apart (first immediate, 2nd +4s,
    // …) to throttle the webhook; email/ntfy fire immediately. Mapping over
    // this.channels in order keeps results[i] aligned with this.labels[i].
    let smsIndex = 0;
    const tasks = this.channels.map((c, i) => {
      const delayMs = this.labels[i] === "sms" ? smsIndex++ * SMS_STAGGER_MS : 0;
      return (async () => {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        return c.send(run, this.alert);
      })();
    });
    if (smsIndex > 1) log.debug(`📱 AlertChannel.send: staggering ${smsIndex} sms send(s) ${SMS_STAGGER_MS}ms apart`);
    const results = await Promise.allSettled(tasks);
    results.forEach((res, i) => {
      const label = this.labels[i] ?? "channel";
      if (res.status === "rejected") {
        const reason = res.reason instanceof Error ? res.reason.message : String(res.reason);
        log.error(`❌ AlertChannel.send: ${label} failed (non-fatal) — ${reason}`);
      } else {
        log.info(`✅ AlertChannel.send: ${label} sent`);
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
