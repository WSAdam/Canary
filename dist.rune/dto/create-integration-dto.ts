import type { RecipientDto } from "./recipient-dto.ts";

/** input for one-step provisioning of a standard health-check integration.
 *  Stands up a monitor + secret + check + alert against a project that exposes
 *  the Canary health contract (POST <baseUrl>/canary/errors → { totalErrors }). */
export interface CreateIntegrationDto {
  name: string;              // unique monitor name, also the secret-key prefix
  description?: string;      // optional; defaults to "Health monitor for <name>"
  baseUrl: string;           // project origin, e.g. https://app.example.deno.net
  secret: string;            // the project's CANARY_SECRET (stored, never returned)
  recipients: RecipientDto[]; // who to alert (sms/email/ntfy)
  cron?: string;             // optional schedule override; defaults to a daily run
}
