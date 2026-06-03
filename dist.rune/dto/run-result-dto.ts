/** the request that produced a run, captured for debugging failed checks */
export interface RunRequestDetailDto {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** the response received during a run, captured for debugging failed checks */
export interface RunResponseDetailDto {
  status?: number;
  body?: string;
  truncated?: boolean;
}

/** the result of a single check run including observed value and status */
export interface RunResultDto {
  runId: string;
  monitorId: string;
  monitorName?: string;
  observed: number;
  passed: boolean;
  timestamp: string;
  error?: string;
  captures?: Record<string, string>;
  // request/response are persisted on FAILED runs only, secret-redacted and
  // body-truncated, so a failed check can be inspected from the Reports tab.
  request?: RunRequestDetailDto;
  response?: RunResponseDetailDto;
}
