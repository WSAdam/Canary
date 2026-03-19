import { BaseAlertChannel } from "../../shared/mod.ts";
import type { RunResultDto } from "../../../../dto/run-result-dto.ts";
import type { AlertDto } from "../../../../dto/alert-dto.ts";
import { CanaryError } from "../../../../dto/_shared.ts";

function applyVars(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((s, [k, v]) => s.replace(new RegExp(`\\{${k}\\}`, "g"), v), template);
}

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
      ? applyVars(alert.smsMessage, { status, monitor: monitorLabel, observed: String(run.observed), timestamp: run.timestamp, ...run.captures })
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
