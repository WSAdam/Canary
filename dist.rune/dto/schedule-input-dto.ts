/** human-friendly schedule input to convert into a cron expression */
export interface ScheduleInputDto {
  timeOfDay: string;
  daysOfWeek: string;
  frequency: string;
}
