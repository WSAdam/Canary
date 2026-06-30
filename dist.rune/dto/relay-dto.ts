/**
 * The relay configuration for a monitor of type "relay". Stored under
 * ["relay", monitorId] — the monitor record (name/description/type) lives under
 * ["monitor", monitorId] as for any monitor. A relay forwards an inbound error,
 * authenticated by a shared token in the fire body, straight to its SMS numbers.
 * The token is kept only as a SHA-256 hash, never in plaintext.
 */
export interface RelayDto {
  numbers: string[]; // destination SMS numbers (1–5)
  template?: string; // optional smsMessage template ({monitor} {error} {observed} {timestamp} {status} + captures)
  tokenHash: string; // SHA-256 hex of the shared token
  createdAt: string;
}

/**
 * The safe read projection of a relay config — everything EXCEPT the token hash,
 * so the edit UI can prefill numbers/template without exposing secret material.
 */
export interface RelayPublicDto {
  numbers: string[];
  hasTemplate: boolean;
  createdAt: string;
}
