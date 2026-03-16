/** the result of a single check run including observed value and status */
export interface RunResultDto {
  runId: string;
  monitorId: string;
  observed: number;
  passed: boolean;
  timestamp: string;
}
