/** The `/api/deno-usage` response: org-wide Deno Deploy usage over a window,
 *  summed across every app. Flat numeric fields so a Canary check can extract
 *  any of them by dot-path (observed) or capture (`{kvReads}` etc.). */
import type { AppUsage } from "../pure/deno-usage/deno-usage.ts";

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
  /** The same metrics per app, busiest first. Capture a single app by index
   *  (`byApp.0.requests`) or the whole array (it serializes to JSON). */
  byApp: AppUsage[];
  /** `byApp` pre-rendered as a fixed-width text table, for an alert body's
   *  `{breakdown}` capture — an array capture would render as raw JSON. */
  breakdown: string;
}
