import type { ConfigureRelayDto } from "../../dto/configure-relay-dto.ts";
import type { RelayPublicDto } from "../../dto/relay-dto.ts";
import { Relay } from "../../impure/relay/relay.ts";
import { CanaryError } from "../../dto/_shared.ts";
import { log } from "../../impure/_log.ts";

const MAX_NAME_LENGTH = 64;
const MAX_NUMBERS = 5; // matches the per-alert SMS fan-out cap (staggered 4s apart at send time)
const MIN_TOKEN_LENGTH = 8; // mirrors the account password policy
const MAX_TOKEN_LENGTH = 256;
const MAX_TEMPLATE_LENGTH = 1000;

export async function configureRelay(input: ConfigureRelayDto): Promise<RelayPublicDto> {
  // typeof guard FIRST: the charset RegExp coerces its arg to a string, so a
  // numeric/missing name would pass the pattern check and reach kv.set as a
  // non-string key part → corrupt namespace / opaque 500.
  if (typeof input.name !== "string" || input.name.trim() === "") {
    throw new CanaryError("validation-error", "Relay name is required and must be a non-empty string", 400);
  }
  // URL-safe charset (no ":" / "/") so the name is unambiguous in the fire path
  // and in the synthetic "relay:<name>" run-history key.
  if (!/^[A-Za-z0-9_-]+$/.test(input.name)) {
    throw new CanaryError("validation-error", "Relay name may only contain letters, numbers, hyphens, and underscores", 400);
  }
  if (input.name.length > MAX_NAME_LENGTH) {
    throw new CanaryError("validation-error", `Relay name must be at most ${MAX_NAME_LENGTH} characters`, 400);
  }

  // Numbers: 1–5 SMS destinations, each 10 or 11 digits — same rule the alert
  // recipients enforce, so a relay can't store a number that delivers nothing.
  if (!Array.isArray(input.numbers) || input.numbers.length === 0) {
    throw new CanaryError("validation-error", "numbers is required and must be a non-empty array", 400);
  }
  if (input.numbers.length > MAX_NUMBERS) {
    throw new CanaryError("validation-error", `A relay may have at most ${MAX_NUMBERS} SMS numbers`, 400);
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

  if (typeof input.token !== "string") {
    throw new CanaryError("validation-error", "token is required and must be a string", 400);
  }
  if (input.token.length < MIN_TOKEN_LENGTH) {
    throw new CanaryError("validation-error", `token must be at least ${MIN_TOKEN_LENGTH} characters`, 400);
  }
  if (input.token.length > MAX_TOKEN_LENGTH) {
    throw new CanaryError("validation-error", `token must be at most ${MAX_TOKEN_LENGTH} characters`, 400);
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

  log.debug(`🚀 relay.configure ${input.name} numbers=${input.numbers.length}`);
  const result = await new Relay().upsert({
    name: input.name,
    numbers: input.numbers,
    token: input.token,
    template: input.template,
  });
  log.debug(`✅ relay.configure ${result.name}`);
  return result;
}
