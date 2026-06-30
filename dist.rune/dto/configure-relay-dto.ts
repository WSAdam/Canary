/** input for setting/replacing the relay config on an existing relay monitor */
export interface ConfigureRelayDto {
  monitorId: string;
  numbers: string[]; // 1–5 destination SMS numbers (10 or 11 digits each)
  token?: string; // the shared secret callers send as `test`; ≥ 16 chars. Omit on reconfigure to keep the current token.
  template?: string; // optional smsMessage template; {monitor} {error} {observed} {timestamp} {status} + captures
}
