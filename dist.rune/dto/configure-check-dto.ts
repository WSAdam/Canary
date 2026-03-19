/** input for attaching or replacing a check configuration on a monitor */
export interface ConfigureCheckDto {
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
