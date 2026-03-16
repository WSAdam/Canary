/** a single typed alert recipient with channel type and contact */
export interface RecipientDto {
  alertType: string; // "sms" | "email"
  contact: string;
}
