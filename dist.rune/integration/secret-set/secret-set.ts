import type { SetSecretDto } from "../../dto/set-secret-dto.ts";
import type { SecretDto } from "../../dto/secret-dto.ts";
import { Secret } from "../../impure/secret/secret.ts";
import { CanaryError } from "../../dto/_shared.ts";

export async function setSecret(input: SetSecretDto): Promise<SecretDto> {
  console.log("🚀 secret.set", input.secretKey);
  // Keys must match the {{KEY}} token charset so they're referenceable in checks.
  if (!/^[A-Za-z0-9_]+$/.test(input.secretKey)) {
    throw new CanaryError("validation-error", "Secret key may only contain letters, numbers, and underscores", 400);
  }
  if (!input.secretValue) {
    throw new CanaryError("validation-error", "Secret value is required", 400);
  }
  const secret = new Secret();
  const result = await secret.upsert(input);
  console.log("✅ secret.set", result.secretKey);
  return result;
}
