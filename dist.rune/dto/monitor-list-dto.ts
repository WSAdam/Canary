import type { MonitorDto } from "./monitor-dto.ts";

/** all configured monitors for the UI dashboard */
export interface MonitorListDto {
  monitors: MonitorDto[];
}
