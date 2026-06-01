import { BaseAlertChannel } from "../../shared/mod.ts";
import type { RunResultDto } from "../../../../dto/run-result-dto.ts";
import type { AlertDto } from "../../../../dto/alert-dto.ts";
import { CanaryError } from "../../../../dto/_shared.ts";

function applyVars(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((s, [k, v]) => s.replace(new RegExp(`\\{${k}\\}`, "g"), v), template);
}

function normalizeNtfyUrl(address: string): string {
  const trimmed = address.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.includes("/")) return "https://" + trimmed;
  return "https://ntfy.sh/" + trimmed;
}

export class Ntfy extends BaseAlertChannel {
  constructor(private readonly address: string) {
    super();
  }

  async send(run: RunResultDto, alert: AlertDto): Promise<void> {
    const url = normalizeNtfyUrl(this.address);
    const status = run.passed ? "RECOVERED" : "FAILED";
    const monitorLabel = run.monitorName || run.monitorId;
    const vars = { status, monitor: monitorLabel, observed: String(run.observed), timestamp: run.timestamp, ...run.captures };

    const defaultTitle = `Canary: ${monitorLabel} ${status}`;
    const title = alert.ntfyTitle ? applyVars(alert.ntfyTitle, vars) : defaultTitle;

    const defaultBody = [
      `${status}`,
      `Monitor: ${monitorLabel}`,
      `Observed: ${run.observed}`,
      `Timestamp: ${run.timestamp}`,
      run.error ? `Error: ${run.error}` : null,
    ].filter(Boolean).join("\n");
    const message = alert.ntfyMessage ? applyVars(alert.ntfyMessage, vars) : defaultBody;

    const priority = run.passed ? "default" : "high";
    const tags = run.passed ? "white_check_mark" : "warning";

    console.log(`🔔 ntfy.send: url=${url} title="${title}" priority=${priority}`);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Title": title,
        "Tags": tags,
        "Priority": priority,
      },
      body: message,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new CanaryError("send-failed", `ntfy returned ${response.status}: ${errBody}`, 500);
    }
  }
}
