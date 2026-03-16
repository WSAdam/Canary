import type { SetSecretDto } from "../../dto/set-secret-dto.ts";
import type { SecretDto } from "../../dto/secret-dto.ts";
import { Secret } from "../../impure/secret/secret.ts";

export async function setSecret(input: SetSecretDto): Promise<SecretDto> {
  console.log("🚀 secret.set", input.secretKey);
  const secret = new Secret();
  const result = await secret.upsert(input);
  console.log("✅ secret.set", result.secretKey);
  return result;
}
