/**
 * request body for POST /relay/:name/fire — push a raw error to a relay's SMS
 * numbers. `test` carries the shared token (the field the relay is driven by).
 * All other fields are optional.
 */
export interface RelayFireDto {
  test?: string; // the shared token
  error?: string; // surfaced as {error} and in the default SMS body
  observed?: number; // default 0, surfaced as {observed}
  captures?: Record<string, string>; // added to the {var} table for template expansion
  message?: string; // overrides the relay's template for this fire only; {var} tokens still expand
}
