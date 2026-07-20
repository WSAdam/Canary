/** input for attaching or replacing a check configuration on a monitor */
export interface ConfigureCheckDto {
  monitorId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  // Ignored (and optional) when reportOnly is set.
  expression: string;
  comparatorOp: string;
  threshold: number;
  cron: string;
  notifyOnRecover: boolean;
  // Alert on every run (a healthy run sends an "all clear"), not just failures.
  notifyOnSuccess?: boolean;
  // Report mode: no comparator — every successful fetch passes and sends.
  reportOnly?: boolean;
  // Optional http(s) link included in every alert (e.g. the app's logs page).
  logsUrl?: string;
  captures?: Record<string, string>;
}
