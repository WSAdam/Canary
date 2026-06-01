/** stored webhook secret state for a monitor — plaintext is never persisted */
export interface WebhookSecretDto {
  hash: string;        // SHA-256 hex of the plaintext secret
  fingerprint: string; // first ~12 chars of the plaintext, for UI display only
  createdAt: string;   // ISO timestamp of generation
}
