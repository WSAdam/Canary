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
  captures?: Record<string, string>;
}
