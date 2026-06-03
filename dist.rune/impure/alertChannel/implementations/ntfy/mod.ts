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
export function sanitizeHeaderValue(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out.trim();
}

/**
 * Turn a user-supplied ntfy address into a request URL, accepting a bare topic
 * (`alerts` → ntfy.sh/alerts), `ntfy.sh/alerts`, `host/topic`, or a full URL
 * (incl. self-hosted servers on any host). Throws on input that can't yield a
 * real topic — empty/whitespace, scheme-only (`https://`), or no topic path
 * (`ntfy.sh/`, `/`) — so a misconfigured recipient fails loudly instead of
 * silently POSTing to the ntfy.sh root.
 */
export function normalizeNtfyUrl(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) {
    throw new CanaryError("validation-error", "ntfy address is empty", 400);
  }

  let candidate: string;
  if (/^https?:\/\//i.test(trimmed)) candidate = trimmed;
  else if (trimmed.includes("/")) candidate = "https://" + trimmed;
  else candidate = "https://ntfy.sh/" + trimmed;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new CanaryError("validation-error", `ntfy address "${address}" is not a valid topic or URL`, 400);
  }
  // Host stays unrestricted (self-hosted ntfy uses arbitrary domains), but there
  // must be a non-empty topic in the path.
  const topic = parsed.pathname.replace(/^\/+|\/+$/g, "");
  if (!topic) {
    throw new CanaryError("validation-error", `ntfy address "${address}" has no topic`, 400);
  }
  return candidate;
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
