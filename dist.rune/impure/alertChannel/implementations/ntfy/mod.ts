import { applyVars, BaseAlertChannel, buildVars } from "../../shared/mod.ts";
import type { RunResultDto } from "../../../../dto/run-result-dto.ts";
import type { AlertDto } from "../../../../dto/alert-dto.ts";
import { CanaryError } from "../../../../dto/_shared.ts";

/**
 * ntfy reads the notification title from an HTTP header. Header values cannot
 * contain CR/LF or other control characters (fetch throws "Invalid header
 * value"), and a captured/user title may contain newlines — so drop control
 * chars (C0 range + DEL) to keep the alert from being dropped.
 */
function sanitizeHeaderValue(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out.trim();
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
    const vars = buildVars(run);

    const defaultTitle = `Canary: ${monitorLabel} ${status}`;
    const title = sanitizeHeaderValue(alert.ntfyTitle ? applyVars(alert.ntfyTitle, vars) : defaultTitle);

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
