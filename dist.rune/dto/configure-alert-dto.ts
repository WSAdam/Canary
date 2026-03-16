import type { RecipientDto } from "./recipient-dto.ts";

/** input for attaching or replacing alert recipients on a monitor */
export interface ConfigureAlertDto {
  monitorId: string;
  recipients: RecipientDto[];
}
