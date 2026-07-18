/** The `/api/deno-usage` response: org-wide Deno Deploy usage over a window,
 *  summed across every app. Flat numeric fields so a Canary check can extract
 *  any of them by dot-path (observed) or capture (`{kvReads}` etc.). */
export interface DenoUsageDto {
  ok: true;
  window: { since: string; until: string; hours: number };
  /** How many apps were summed (and how many analytics calls failed, if any). */
  apps: number;
  appsErrored: number;
  requests: number;
  kvReadUnits: number;
  kvWriteUnits: number;
  egressGB: number;
  cpuHours: number;
  memoryGBHours: number;
}
