import { BaseAlertChannel } from "../../shared/mod.ts";
import type { RunResultDto } from "../../../../dto/run-result-dto.ts";
import { CanaryError } from "../../../../dto/_shared.ts";

export class Email extends BaseAlertChannel {
  constructor(private readonly emailAddress: string) {
    super();
  }

  async send(dto: RunResultDto): Promise<void> {
    const token = Deno.env.get("POSTMARK_SERVER_TOKEN");
    const from = Deno.env.get("POSTMARK_FROM_EMAIL");
    if (!token) throw new CanaryError("send-failed", "POSTMARK_SERVER_TOKEN is not configured", 500);
    if (!from) throw new CanaryError("send-failed", "POSTMARK_FROM_EMAIL is not configured", 500);

    const status = dto.passed ? "RECOVERED" : "FAILED";
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
        Subject: `Canary Alert: Monitor ${dto.monitorId} ${status}`,
        TextBody: buildEmailBody(dto),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new CanaryError("send-failed", `Postmark returned ${response.status}: ${body}`, 500);
    }
  }
}

function buildEmailBody(dto: RunResultDto): string {
  const status = dto.passed ? "✅ RECOVERED" : "❌ FAILED";
  return [
    `Status:    ${status}`,
    `Monitor:   ${dto.monitorId}`,
    `Observed:  ${dto.observed}`,
    `Run ID:    ${dto.runId}`,
    `Timestamp: ${dto.timestamp}`,
  ].join("\n");
}
