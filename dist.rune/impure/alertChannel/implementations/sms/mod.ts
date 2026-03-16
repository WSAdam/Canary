import { BaseAlertChannel } from "../../shared/mod.ts";
import type { RunResultDto } from "../../../../dto/run-result-dto.ts";
import { CanaryError } from "../../../../dto/_shared.ts";

export class Sms extends BaseAlertChannel {
  constructor(private readonly phoneNumber: string) {
    super();
  }

  async send(dto: RunResultDto): Promise<void> {
    const url = Deno.env.get("ZAPIER_SMS_URL");
    if (!url) throw new CanaryError("send-failed", "ZAPIER_SMS_URL is not configured", 500);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Number: this.phoneNumber,
        Message: buildSmsMessage(dto),
      }),
    });

    if (!response.ok) {
      throw new CanaryError("send-failed", `Zapier SMS webhook returned ${response.status}`, 500);
    }
  }
}

function buildSmsMessage(dto: RunResultDto): string {
  const status = dto.passed ? "✅ RECOVERED" : "❌ FAILED";
  return `Canary ${status} — monitor: ${dto.monitorId}, observed: ${dto.observed}, at: ${dto.timestamp}`;
}
