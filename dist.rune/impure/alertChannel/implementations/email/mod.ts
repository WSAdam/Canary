import { applyVars, BaseAlertChannel, buildVars } from "../../shared/mod.ts";
import type { RunResultDto } from "../../../../dto/run-result-dto.ts";
import type { AlertDto } from "../../../../dto/alert-dto.ts";
import { CanaryError } from "../../../../dto/_shared.ts";
import { log } from "../../../_log.ts";

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
    const vars = buildVars(run);
    const defaultSubject = `Canary Alert: ${monitorLabel} ${status}`;
    const subject = alert.emailSubject ? applyVars(alert.emailSubject, vars) : defaultSubject;

    const defaultBody = buildEmailBody(run);
    const body = alert.emailMessage ? applyVars(alert.emailMessage, vars) : defaultBody;

    log.info(`📧 email.send: to=${this.emailAddress} subject="${subject}"`);
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

export function buildEmailBody(run: RunResultDto): string {
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
  // Include the captured HTTP response body so the failure email is
  // self-contained (no need to open the dashboard to see what failed). Only
  // failed runs carry run.response, so recovered emails stay clean. Pretty-
  // printed when it's JSON; raw otherwise.
  if (run.response?.body) {
    lines.push("", "Response:", prettyJson(run.response.body));
    if (run.response.truncated) lines.push("(truncated)");
  }
  return lines.join("\n");
}

function prettyJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
