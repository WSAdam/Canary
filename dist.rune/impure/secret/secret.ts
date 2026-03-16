import { kv } from "../_kv.ts";
import type { SetSecretDto } from "../../dto/set-secret-dto.ts";
import type { SecretDto } from "../../dto/secret-dto.ts";
import type { SecretListDto } from "../../dto/secret-list-dto.ts";
import { CanaryError } from "../../dto/_shared.ts";

export class Secret {
  async upsert(dto: SetSecretDto): Promise<SecretDto> {
    await kv.set(["secret", dto.secretKey], dto.secretValue);
    return { secretKey: dto.secretKey };
  }

  async list(): Promise<SecretListDto> {
    const secrets: SecretDto[] = [];
    for await (const entry of kv.list({ prefix: ["secret"] })) {
      secrets.push({ secretKey: entry.key[1] as string });
    }
    return { secrets };
  }

  async get(secretKey: string): Promise<SecretDto> {
    const result = await kv.get(["secret", secretKey]);
    if (result.value === null) {
      throw new CanaryError("not-found", `Secret "${secretKey}" not found`, 404);
    }
    return { secretKey };
  }

  async delete(secretKey: string): Promise<void> {
    await kv.delete(["secret", secretKey]);
  }
}
