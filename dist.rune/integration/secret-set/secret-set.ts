import type { SetSecretDto } from "../../dto/set-secret-dto.ts";
import type { SecretDto } from "../../dto/secret-dto.ts";
import { Secret } from "../../impure/secret/secret.ts";
import { CanaryError } from "../../dto/_shared.ts";
import { log } from "../../impure/_log.ts";

// Bounds so an oversized key/value is rejected with a 400 rather than blowing
// past Deno KV's ~2 KiB key / 64 KiB value limits as an opaque 500.
const MAX_SECRET_KEY_LENGTH = 256;
const MAX_SECRET_VALUE_LENGTH = 60 * 1024;

export async function setSecret(input: SetSecretDto): Promise<SecretDto> {
  log.debug("🚀 secret.set", typeof input.secretKey === "string" ? input.secretKey : "(non-string)");
  // typeof guard FIRST: RegExp.test coerces its arg to a string, so a numeric or
  // missing secretKey would pass the charset check and reach kv.set as a
  // non-string/undefined key part — corrupting the namespace or throwing a 500.
  if (typeof input.secretKey !== "string") {
    throw new CanaryError("validation-error", "Secret key is required and must be a string", 400);
  }
  // Keys must match the {{KEY}} token charset so they're referenceable in checks.
  if (!/^[A-Za-z0-9_]+$/.test(input.secretKey)) {
    throw new CanaryError("validation-error", "Secret key may only contain letters, numbers, and underscores", 400);
  }
  if (input.secretKey.length > MAX_SECRET_KEY_LENGTH) {
    throw new CanaryError("validation-error", `Secret key must be at most ${MAX_SECRET_KEY_LENGTH} characters`, 400);
  }
  if (typeof input.secretValue !== "string" || input.secretValue === "") {
    throw new CanaryError("validation-error", "Secret value is required", 400);
  }
  // Bound by serialized BYTES, not .length (UTF-16 code units): Deno KV's ~64 KiB
  // per-value cap is on bytes, so a sub-limit count of multi-byte chars (emoji,
  // CJK) could still blow past it and surface as an opaque 500. Measure bytes.
  if (new TextEncoder().encode(input.secretValue).length > MAX_SECRET_VALUE_LENGTH) {
    throw new CanaryError("validation-error", `Secret value must be at most ${MAX_SECRET_VALUE_LENGTH} bytes`, 400);
  }
  const secret = new Secret();
  const result = await secret.upsert(input);
  log.debug("✅ secret.set", result.secretKey);
  return result;
}
