import { BaseAlertChannel } from "../../shared/mod.ts";
import type { RunResultDto } from "../../../../dto/run-result-dto.ts";
import type { AlertDto } from "../../../../dto/alert-dto.ts";
import { CanaryError } from "../../../../dto/_shared.ts";

export class Sms extends BaseAlertChannel {
  constructor(private readonly phoneNumber: string) {
    super();
  }

  async send(run: RunResultDto, alert: AlertDto): Promise<void> {
    const url = Deno.env.get("ZAPIER_SMS_URL");
    if (!url) throw new CanaryError("send-failed", "ZAPIER_SMS_URL is not configured", 500);

    const status = run.passed ? "RECOVERED" : "FAILED";
    const monitorLabel = run.monitorName || run.monitorId;
    const defaultMessage = `Canary ${status}: ${monitorLabel} — observed: ${run.observed} at ${run.timestamp}`;
    const message = alert.smsMessage
      ? alert.smsMessage
          .replace(/\{status\}/g, status)
          .replace(/\{monitor\}/g, monitorLabel)
          .replace(/\{observed\}/g, String(run.observed))
          .replace(/\{timestamp\}/g, run.timestamp)
      : defaultMessage;

    const number = this.phoneNumber.replace(/^\+/, "");
    console.log(`📱 sms.send: to=${number}`);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number, message }),
    });

    if (!response.ok) {
      throw new CanaryError("send-failed", `Zapier SMS webhook returned ${response.status}`, 500);
    }
  }
}
