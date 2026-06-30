import type { MonitorType } from "./monitor-dto.ts";

/** input for creating a new named monitor */
export interface CreateMonitorDto {
  name: string;
  description: string;
  type?: MonitorType; // defaults to "check" when omitted
}
