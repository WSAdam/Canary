/** input for creating a relay monitor in one call (POST /relays) — provisions
 *  a monitor of type "relay" plus its relay config */
export interface CreateRelayDto {
  name: string;
  description?: string;
  numbers: string[]; // 1–5 destination SMS numbers (10 or 11 digits each)
  token: string; // the shared secret callers send as `test`; ≥ 16 chars
  template?: string; // optional smsMessage template; {monitor} {error} {observed} {timestamp} {status} + captures
}
