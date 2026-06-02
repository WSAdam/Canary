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
