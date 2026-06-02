import { applyVars, BaseAlertChannel, buildVars } from "../../shared/mod.ts";
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
    const vars = buildVars(run);
    const detail = run.error ? `error: ${run.error}` : `observed: ${run.observed}`;
    const defaultMessage = `Canary ${status}: ${monitorLabel} — ${detail} at ${run.timestamp}`;
    const message = alert.smsMessage ? applyVars(alert.smsMessage, vars) : defaultMessage;

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
