import type { SecretListDto } from "../../dto/secret-list-dto.ts";
import { Secret } from "../../impure/secret/secret.ts";
import { log } from "../../impure/_log.ts";

export async function listSecrets(): Promise<SecretListDto> {
  log.debug("🚀 secret.list");
  const secret = new Secret();
  const result = await secret.list();
  log.debug("✅ secret.list", result.secrets.length, "keys");
  return result;
}
