/**
 * A configured inbound SMS relay: a named endpoint that an external project can
 * POST a raw error to (authenticated by a shared token in the body) and have it
 * forwarded straight to a fixed set of SMS numbers — no monitor/check required.
 * Stored under ["relay", name]. The token is kept only as a SHA-256 hash, never
 * in plaintext, mirroring the per-monitor webhook secret.
 */
export interface RelayDto {
  name: string;
  numbers: string[]; // destination SMS numbers (1–5)
  template?: string; // optional smsMessage template ({monitor} {error} {observed} {timestamp} {status} + captures)
  tokenHash: string; // SHA-256 hex of the shared token
  createdAt: string;
}

/**
 * The safe read/list projection of a relay — everything EXCEPT the token hash,
 * so listing relays can never leak secret material (parallels how secret-list
 * returns key names only).
 */
export interface RelayPublicDto {
  name: string;
  numbers: string[];
  hasTemplate: boolean;
  createdAt: string;
}
