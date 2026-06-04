/** input for renaming / editing an existing monitor's name + description */
export interface UpdateMonitorDto {
  monitorId: string;
  name: string;
  description: string;
}
