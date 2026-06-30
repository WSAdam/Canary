import type { RunResultDto } from "../../../dto/run-result-dto.ts";
import type { AlertDto } from "../../../dto/alert-dto.ts";

export abstract class BaseAlertChannel {
  abstract send(run: RunResultDto, alert: AlertDto): Promise<void>;
}

/**
 * Substitute {token} placeholders in a template from a vars map.
 * Uses a replacer function so literal "$" sequences in values (e.g. a
 * captured price like "$5") are inserted verbatim rather than being
 * interpreted as String.replace special patterns ($&, $1, $$, …).
 * Unknown tokens are left untouched.
 */
export function applyVars(template: string, vars: Record<string, string>): string {
  return template.replace(
    /\{([^{}]+)\}/g,
    (match, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match),
  );
}

/**
 * Build an alert's message body: render the operator's custom template (or the
 * channel's default), then GUARANTEE a failure's error is surfaced.
 *
 * Without this, a custom template tuned for a metric breach — e.g. an
 * "Activations SMS" monitor whose smsMessage is "Send some activation texts" —
 * is sent VERBATIM when the check actually failed for a transport reason (HTTP
 * 401 / timeout / extraction error). The check never measured the metric, yet the
 * recipient gets a message implying it did, so a monitoring/auth failure
 * masquerades as a real metric result. If the run errored and the rendered text
 * doesn't already mention the error (template has no {error} token), append it so
 * the alert is honest. Templates that DO use {error} (relays, error-formatting
 * webhooks) already contain it, so nothing is appended twice.
 */
export function renderAlertMessage(
  template: string | undefined,
  run: RunResultDto,
  vars: Record<string, string>,
  fallback: string,
): string {
  const base = template ? applyVars(template, vars) : fallback;
  if (run.error && !base.includes(run.error)) return `${base} — error: ${run.error}`;
  return base;
}

/**
 * Standard template variables available to every alert channel. Includes
 * `error` so that down/erroring runs produce a meaningful message instead of
 * a bare "observed: 0". Capture values are spread last so a check can expose
 * its own variables (but cannot shadow `error`/`status` accidentally unless it
 * names a capture identically — acceptable).
 */
export function buildVars(run: RunResultDto): Record<string, string> {
  const status = run.passed ? "RECOVERED" : "FAILED";
  const monitorLabel = run.monitorName || run.monitorId;
  return {
    status,
    monitor: monitorLabel,
    observed: String(run.observed),
    timestamp: run.timestamp,
    error: run.error ?? "",
    ...run.captures,
  };
}
