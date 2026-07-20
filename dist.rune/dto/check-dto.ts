/** resolved check configuration for a monitor */
export interface CheckDto {
  monitorId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  expression: string;
  comparatorOp: string;
  threshold: number;
  cron: string;
  notifyOnRecover: boolean;
  // When true, alert on EVERY run, not just failures/recovery — a healthy run
  // sends an "all clear" (e.g. "0 errors found"). Optional so legacy check rows
  // (written before this existed) read as undefined and are treated as false.
  notifyOnSuccess?: boolean;
  // REPORT MODE: no comparator at all. Every successful fetch passes and sends
  // (implies notifyOnSuccess) — for digests/reports where a threshold check is
  // meaningless and "FAILED because 23 > 23 is false" is nonsense. A fetch or
  // parse error still fails loud. expression/comparatorOp/threshold are ignored.
  reportOnly?: boolean;
  // Optional link surfaced in every alert (e.g. the monitored app's logs page)
  // so a recipient can click through to verify. http(s) only; validated at
  // configure time.
  logsUrl?: string;
  captures?: Record<string, string>;
}
