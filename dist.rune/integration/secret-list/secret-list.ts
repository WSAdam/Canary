import type { SecretListDto } from "../../dto/secret-list-dto.ts";
import { Secret } from "../../impure/secret/secret.ts";

export async function listSecrets(): Promise<SecretListDto> {
  console.log("🚀 secret.list");
  const secret = new Secret();
  const result = await secret.list();
  console.log("✅ secret.list", result.secrets.length, "keys");
  return result;
}
