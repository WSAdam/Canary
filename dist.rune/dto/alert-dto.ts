import type { RecipientDto } from "./recipient-dto.ts";

/** resolved alert channel configuration for a monitor */
export interface AlertDto {
  monitorId: string;
  recipients: RecipientDto[];
  emailSubject?: string;
  emailMessage?: string;
  smsMessage?: string;
}
