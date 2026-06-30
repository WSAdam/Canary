/**
 * request body for POST /relay/:monitorId/fire — push a raw error to a relay
 * monitor's SMS numbers.
 *
 * Auth: the shared token is accepted as `Authorization: Bearer <token>` (the
 * conventional path) OR in the body as `test`. All fields below are optional.
 *
 * Any EXTRA top-level field not listed here (e.g. `source`, `kind`, `phone`,
 * `attempts`, `ts`) is folded into the run's captures — preserved in Reports and
 * usable as a `{var}` in the SMS template — so a structured failure payload
 * needs no nesting under `captures`.
 */
export interface RelayFireDto {
  test?: string; // the shared token (when not sent as an Authorization: Bearer header)
  error?: string; // surfaced as {error} and in the default SMS body
  observed?: number; // default 0, surfaced as {observed}
  captures?: Record<string, string>; // explicit {var} table; merged with (and wins over) extra top-level fields
  message?: string; // overrides the relay's template for this fire only; {var} tokens still expand
}
