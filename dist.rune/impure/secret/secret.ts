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
    const result = await kv.get(["secret", secretKey], { consistency: "strong" });
    if (result.value === null) {
      throw new CanaryError("not-found", `Secret "${secretKey}" not found`, 404);
    }
    return { secretKey };
  }

  /**
   * Resolve a secret to its raw value for server-side interpolation into an
   * outbound check. Never expose this over the HTTP API — only `get`/`list`
   * (which return key names only) are safe to surface.
   */
  async resolve(secretKey: string): Promise<string> {
    const result = await kv.get<string>(["secret", secretKey], { consistency: "strong" });
    if (result.value === null) {
      throw new CanaryError("not-found", `Secret "${secretKey}" not found`, 404);
    }
    return result.value;
  }

  async delete(secretKey: string): Promise<void> {
    await kv.delete(["secret", secretKey]);
  }
}
