import type { ConfigureRelayDto } from "../../dto/configure-relay-dto.ts";
import type { RelayPublicDto } from "../../dto/relay-dto.ts";
import { Relay } from "../../impure/relay/relay.ts";
import { CanaryError } from "../../dto/_shared.ts";
import { log } from "../../impure/_log.ts";

export const MAX_RELAY_NUMBERS = 5; // matches the per-alert SMS fan-out cap
export const MIN_RELAY_TOKEN_LENGTH = 16; // machine-to-machine secret (see note below)
const MAX_TOKEN_LENGTH = 256;
const MAX_TEMPLATE_LENGTH = 1000;

/**
 * Validate and store a monitor's relay config. The token is optional on
 * reconfigure: omit it to keep the current one (so an operator can edit the
 * numbers/template without re-entering the secret); it's required the first time.
 *
 * A relay token is a machine-to-machine secret guarding a public, SMS-triggering
 * endpoint — require ≥ 16 chars of entropy so the unsalted SHA-256 stored at rest
 * isn't brute-forceable if KV is ever dumped.
 */
export async function configureRelay(input: ConfigureRelayDto): Promise<RelayPublicDto> {
  if (typeof input.monitorId !== "string" || input.monitorId === "") {
    throw new CanaryError("validation-error", "monitorId is required", 400);
  }

  // Numbers: 1–5 SMS destinations, each 10 or 11 digits — same rule the alert
  // recipients enforce, so a relay can't store a number that delivers nothing.
  if (!Array.isArray(input.numbers) || input.numbers.length === 0) {
    throw new CanaryError("validation-error", "numbers is required and must be a non-empty array", 400);
  }
  if (input.numbers.length > MAX_RELAY_NUMBERS) {
    throw new CanaryError("validation-error", `A relay may have at most ${MAX_RELAY_NUMBERS} SMS numbers`, 400);
  }
  for (const n of input.numbers) {
    if (typeof n !== "string") {
      throw new CanaryError("validation-error", "Each SMS number must be a string", 400);
    }
    const digits = n.replace(/[^0-9]/g, "");
    if (digits.length < 10 || digits.length > 11) {
      throw new CanaryError("validation-error", `SMS number "${n}" must be 10 or 11 digits (e.g. 18432222986)`, 400);
    }
  }

  // template is applyVars'd at send time (template.replace(...)); a non-string
  // would throw there and get swallowed → a relay that saves 200 but silently
  // sends nothing. Reject at the boundary, like configureAlert does.
  if (input.template !== undefined) {
    if (typeof input.template !== "string") {
      throw new CanaryError("validation-error", "template must be a string", 400);
    }
    if (input.template.length > MAX_TEMPLATE_LENGTH) {
      throw new CanaryError("validation-error", `template must be at most ${MAX_TEMPLATE_LENGTH} characters`, 400);
    }
  }

  const relay = new Relay();

  // Resolve the token hash: hash a supplied token, or reuse the existing one when
  // omitted (reconfigure). A first-time configure with no token is rejected.
  let tokenHash: string;
  if (input.token !== undefined && input.token !== "") {
    if (typeof input.token !== "string") {
      throw new CanaryError("validation-error", "token must be a string", 400);
    }
    if (input.token.length < MIN_RELAY_TOKEN_LENGTH) {
      throw new CanaryError("validation-error", `token must be at least ${MIN_RELAY_TOKEN_LENGTH} characters`, 400);
    }
    if (input.token.length > MAX_TOKEN_LENGTH) {
      throw new CanaryError("validation-error", `token must be at most ${MAX_TOKEN_LENGTH} characters`, 400);
    }
    tokenHash = await Relay.hash(input.token);
  } else {
    const existing = await relay.peek(input.monitorId);
    if (!existing) {
      throw new CanaryError("validation-error", "token is required when first configuring a relay", 400);
    }
    tokenHash = existing.tokenHash;
  }

  log.debug(`🚀 relay.configure ${input.monitorId} numbers=${input.numbers.length}`);
  const result = await relay.upsert(input.monitorId, input.numbers, tokenHash, input.template);
  log.debug(`✅ relay.configure ${input.monitorId}`);
  return result;
}
