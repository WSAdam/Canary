/** input for creating or replacing an inbound SMS relay (POST /relays, upsert by name) */
export interface ConfigureRelayDto {
  name: string;
  numbers: string[]; // 1–5 destination SMS numbers (10 or 11 digits each)
  token: string; // the shared secret callers send as `test` when firing; stored hashed, ≥ 8 chars
  template?: string; // optional smsMessage template; {monitor} {error} {observed} {timestamp} {status} + captures
}
