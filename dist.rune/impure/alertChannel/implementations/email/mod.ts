import { BaseAlertChannel } from "../../shared/mod.ts";
import type { RunResultDto } from "../../../../dto/run-result-dto.ts";
import type { AlertDto } from "../../../../dto/alert-dto.ts";
import { CanaryError } from "../../../../dto/_shared.ts";

function applyVars(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((s, [k, v]) => s.replace(new RegExp(`\\{${k}\\}`, "g"), v), template);
}

export class Email extends BaseAlertChannel {
  constructor(private readonly emailAddress: string) {
    super();
  }

  async send(run: RunResultDto, alert: AlertDto): Promise<void> {
    const token = Deno.env.get("POSTMARK_SERVER_TOKEN");
    const from = Deno.env.get("POSTMARK_FROM_EMAIL");
    if (!token) throw new CanaryError("send-failed", "POSTMARK_SERVER_TOKEN is not configured", 500);
    if (!from) throw new CanaryError("send-failed", "POSTMARK_FROM_EMAIL is not configured", 500);

    const status = run.passed ? "RECOVERED" : "FAILED";
    const monitorLabel = run.monitorName || run.monitorId;
    const defaultSubject = `Canary Alert: ${monitorLabel} ${status}`;
    const subject = alert.emailSubject
      ? applyVars(alert.emailSubject, { status, monitor: monitorLabel, observed: String(run.observed), timestamp: run.timestamp, ...run.captures })
      : defaultSubject;

    const defaultBody = buildEmailBody(run);
    const body = alert.emailMessage
      ? applyVars(alert.emailMessage, { status, monitor: monitorLabel, observed: String(run.observed), timestamp: run.timestamp, ...run.captures })
      : defaultBody;

    console.log(`📧 email.send: to=${this.emailAddress} subject="${subject}"`);
    const response = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": token,
      },
      body: JSON.stringify({
        From: from,
        To: this.emailAddress,
        Subject: subject,
        TextBody: body,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new CanaryError("send-failed", `Postmark returned ${response.status}: ${errBody}`, 500);
    }
  }
}

function buildEmailBody(run: RunResultDto): string {
  const status = run.passed ? "✅ RECOVERED" : "❌ FAILED";
  const monitorLabel = run.monitorName || run.monitorId;
  const lines = [
    `Status:    ${status}`,
    `Monitor:   ${monitorLabel}`,
    `Observed:  ${run.observed}`,
    `Run ID:    ${run.runId}`,
    `Timestamp: ${run.timestamp}`,
  ];
  if (run.error) lines.push(`Error:     ${run.error}`);
  return lines.join("\n");
}
