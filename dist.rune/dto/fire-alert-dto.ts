/** request body for POST /webhook/:monitorId/fire — all fields optional */
export interface FireAlertDto {
  message?: string;                    // raw override of the alert body (no var expansion)
  title?: string;                      // raw override of the ntfy/email title
  passed?: boolean;                    // default false (treats fire as a failure)
  observed?: number;                   // default 0, surfaced as {observed}
  error?: string;                      // surfaced as {error} and included in default body
  captures?: Record<string, string>;   // added to the {var} table for template expansion
}
