/** the kind of monitor: a cron-polled check, or a push-driven inbound SMS relay */
export type MonitorType = "check" | "relay";

/** a resolved monitor with its identifier and display fields */
export interface MonitorDto {
  monitorId: string;
  name: string;
  description: string;
  // Absent on records written before relays existed — normalized to "check" on
  // read (see Monitor.get/list/update), so legacy monitors keep behaving as checks.
  type: MonitorType;
}
