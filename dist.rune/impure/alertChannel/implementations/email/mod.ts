import { applyVars, type AlertContext, BaseAlertChannel, buildVars, renderAlertMessage, statusLabel } from "../../shared/mod.ts";
import type { RunResultDto } from "../../../../dto/run-result-dto.ts";
import type { AlertDto } from "../../../../dto/alert-dto.ts";
import { CanaryError, upstreamStatus } from "../../../../dto/_shared.ts";
import { log } from "../../../_log.ts";

export class Email extends BaseAlertChannel {
  constructor(private readonly emailAddress: string) {
    super();
  }

  async send(run: RunResultDto, alert: AlertDto, ctx?: AlertContext): Promise<void> {
    const token = Deno.env.get("POSTMARK_SERVER_TOKEN");
    const from = Deno.env.get("POSTMARK_FROM_EMAIL");
    if (!token) throw new CanaryError("send-failed", "POSTMARK_SERVER_TOKEN is not configured", 500);
    if (!from) throw new CanaryError("send-failed", "POSTMARK_FROM_EMAIL is not configured", 500);

    const status = statusLabel(run, ctx);
    const monitorLabel = run.monitorName || run.monitorId;
    const vars = buildVars(run, ctx);
    // "Alert" only reads right on a failure; a heartbeat/recovery is good news.
    const defaultSubject = status === "FAILED"
      ? `Canary Alert: ${monitorLabel} FAILED`
      : `Canary: ${monitorLabel} ${status}`;
    const subject = alert.emailSubject ? applyVars(alert.emailSubject, vars) : defaultSubject;

    const defaultBody = buildEmailBody(run, ctx);
    const body = renderAlertMessage(alert.emailMessage, run, vars, defaultBody);

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
      // A 4xx from Postmark (e.g. 422 invalid recipient) is a config/client
      // error — surface it as 4xx so /test-alert doesn't misreport a bad address
      // as a 500 "our fault". Only a true upstream 5xx maps to a 502.
      const status = upstreamStatus(response.status);
      throw new CanaryError("send-failed", `Postmark returned ${response.status}: ${errBody}`, status);
    }
    // Success path: drain the unused body so the stream/connection is released.
    await response.body?.cancel();
  }
}

export function buildEmailBody(run: RunResultDto, ctx?: AlertContext): string {
  const word = statusLabel(run, ctx); // OK / RECOVERED / FAILED
  const status = word === "FAILED" ? "❌ FAILED" : `✅ ${word}`;
  const monitorLabel = run.monitorName || run.monitorId;
  const lines = [
    `Status:    ${status}`,
    `Monitor:   ${monitorLabel}`,
    `Observed:  ${run.observed}`,
    `Run ID:    ${run.runId}`,
    `Timestamp: ${run.timestamp}`,
  ];
  if (run.error) lines.push(`Error:     ${run.error}`);
  // A per-monitor logs link (when configured) so an all-clear email is
  // verifiable — click through to the app's own logs rather than trusting the 0.
  if (ctx?.logsUrl) lines.push(`Logs:      ${ctx.logsUrl}`);
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
