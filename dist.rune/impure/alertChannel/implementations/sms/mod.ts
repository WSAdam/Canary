import { applyVars, BaseAlertChannel, buildVars } from "../../shared/mod.ts";
import type { RunResultDto } from "../../../../dto/run-result-dto.ts";
import type { AlertDto } from "../../../../dto/alert-dto.ts";
import { CanaryError, upstreamStatus } from "../../../../dto/_shared.ts";
import { log } from "../../../_log.ts";

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
    log.info(`📱 sms.send: to=${number}`);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number, message }),
    });

    if (!response.ok) {
      // Read the upstream body on the error path (matching email/ntfy) so the
      // failure carries Zapier's reason, not just the status. This consumes the
      // body, so the success path below drains it instead.
      const errBody = await response.text().catch(() => "");
      const status = upstreamStatus(response.status);
      throw new CanaryError("send-failed", `Zapier SMS webhook returned ${response.status}: ${errBody}`, status);
    }
    // Success path: drain the unused body so the stream/connection is released.
    await response.body?.cancel();
  }
}
