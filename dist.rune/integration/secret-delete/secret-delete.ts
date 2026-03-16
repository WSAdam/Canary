import type { SecretKeyDto } from "../../dto/secret-key-dto.ts";
import type { SecretDto } from "../../dto/secret-dto.ts";
import { Secret } from "../../impure/secret/secret.ts";

export async function deleteSecret(input: SecretKeyDto): Promise<SecretDto> {
  console.log("🚀 secret.delete", input.secretKey);
  const secret = new Secret();
  const existing = await secret.get(input.secretKey); // throws not-found if missing
  await secret.delete(input.secretKey);
  console.log("✅ secret.delete", existing.secretKey);
  return existing;
}
