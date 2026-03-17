/** a single typed alert recipient with channel type and contact */
export interface RecipientDto {
  channel: string; // "sms" | "email"
  address: string;
}
