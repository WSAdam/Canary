import type { ConfigureAlertDto } from "../../dto/configure-alert-dto.ts";
import type { AlertDto } from "../../dto/alert-dto.ts";
import { Alert } from "../../impure/alert/alert.ts";
import { Monitor } from "../../impure/monitor/monitor.ts";
import { normalizeNtfyUrl } from "../../impure/alertChannel/implementations/ntfy/mod.ts";
import { CanaryError } from "../../dto/_shared.ts";
import { log } from "../../impure/_log.ts";

const KNOWN_CHANNELS = new Set(["sms", "email", "ntfy"]);

export async function configureAlert(input: ConfigureAlertDto): Promise<AlertDto> {
  // Reject orphan alerts: an ["alert", monitorId] row with no owning monitor
  // record would never be reaped (no monitor-delete path) and desyncs the
  // namespace — mirror configureCheck's explicit orphan guard.
  await new Monitor().get(input.monitorId); // throws not-found
  // Validate the recipients shape before dereferencing — a missing or non-array
  // `recipients` would otherwise throw a raw TypeError (.length / for..of) → 500.
  if (!Array.isArray(input.recipients)) {
    throw new CanaryError("validation-error", "recipients is required and must be an array", 400);
  }
  log.debug("🚀 alert.configure", input.monitorId, input.recipients.length, "recipients");
  // Reject unusable recipients at save time so the alert can't be stored in a
  // state that reports fired:true at send time while silently delivering nothing
  // (an unknown channel is skipped by AlertChannel.fromAlert; a blank address
  // no-ops). Validate channel + address, and ntfy topics via the send-time
  // normalizer.
  for (const r of input.recipients) {
    if (!r || typeof r.channel !== "string" || !KNOWN_CHANNELS.has(r.channel)) {
      throw new CanaryError("validation-error", `Unknown alert channel "${r?.channel}" — expected sms, email, or ntfy`, 400);
    }
    if (typeof r.address !== "string" || r.address.trim() === "") {
      throw new CanaryError("validation-error", `Recipient address is required for the ${r.channel} channel`, 400);
    }
    // SMS: enforce the 10-or-11-digit rule server-side too. The SPA checks this,
    // but the API is the authority — a direct caller must not be able to store a
    // malformed number (e.g. "abc") that reports fired:true while delivering
    // nothing/garbled at send time (Sms.send only strips a leading "+").
    if (r.channel === "sms") {
      const digits = r.address.replace(/[^0-9]/g, "");
      if (digits.length < 10 || digits.length > 11) {
        throw new CanaryError("validation-error", `SMS number "${r.address}" must be 10 or 11 digits (e.g. 18432222986)`, 400);
      }
      continue;
    }
    if (r.channel !== "ntfy") continue;
    try {
      normalizeNtfyUrl(r.address);
    } catch {
      throw new CanaryError("validation-error", `ntfy topic "${r.address}" is invalid — use a topic name or full ntfy URL`, 400);
    }
  }
  // Type-check the optional template fields. They're applyVars'd at send time
  // (template.replace(...)); a non-string (e.g. a number from a direct API
  // caller) passes the truthy guard there and throws a TypeError that
  // persistRunAndAlert swallows as fired:false — so a misconfigured alert saves
  // 200 but then silently fails to deliver EVERY alert. Reject at the boundary.
  for (const field of ["emailSubject", "emailMessage", "smsMessage", "ntfyTitle", "ntfyMessage"] as const) {
    const v = (input as unknown as Record<string, unknown>)[field];
    if (v !== undefined && typeof v !== "string") {
      throw new CanaryError("validation-error", `${field} must be a string`, 400);
    }
  }
  const alert = Alert.build(input);
  const alertDto = alert.toDto();
  const result = await alert.upsert(alertDto);
  log.debug("✅ alert.configure", result.monitorId);
  return result;
}
