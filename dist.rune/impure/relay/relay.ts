import { kv } from "../_kv.ts";
import { CanaryError, constantTimeEqual } from "../../dto/_shared.ts";
import type { RelayDto, RelayPublicDto } from "../../dto/relay-dto.ts";
import type { ConfigureRelayDto } from "../../dto/configure-relay-dto.ts";
import type { RelayListDto } from "../../dto/relay-list-dto.ts";
import { log } from "../_log.ts";

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(digest);
}

/** Strip the token hash before a relay leaves the server. */
function toPublic(dto: RelayDto): RelayPublicDto {
  return { name: dto.name, numbers: dto.numbers, hasTemplate: !!dto.template, createdAt: dto.createdAt };
}

export class Relay {
  /**
   * Create or replace a relay (upsert by name). The plaintext token is hashed
   * here and never persisted — to "rotate" a token, upsert the relay again with
   * a new one.
   */
  async upsert(input: ConfigureRelayDto): Promise<RelayPublicDto> {
    const dto: RelayDto = {
      name: input.name,
      numbers: input.numbers,
      template: input.template,
      tokenHash: await sha256Hex(input.token),
      createdAt: new Date().toISOString(),
    };
    await kv.set(["relay", input.name], dto);
    log.debug(`📮 relay.upsert: name=${input.name} numbers=${input.numbers.length}`);
    return toPublic(dto);
  }

  async list(): Promise<RelayListDto> {
    const relays: RelayPublicDto[] = [];
    for await (const entry of kv.list<RelayDto>({ prefix: ["relay"] })) {
      relays.push(toPublic(entry.value));
    }
    return { relays };
  }

  async get(name: string): Promise<RelayPublicDto> {
    const result = await kv.get<RelayDto>(["relay", name], { consistency: "strong" });
    if (result.value === null) {
      throw new CanaryError("not-found", `Relay "${name}" not found`, 404);
    }
    return toPublic(result.value);
  }

  async delete(name: string): Promise<void> {
    await kv.delete(["relay", name]);
    log.debug(`📮 relay.delete: name=${name}`);
  }

  /**
   * Authenticate a fire request and return the stored relay (numbers + template)
   * on success. A missing relay and a wrong token both surface the same 401 so a
   * caller can't probe which relay names exist. Constant-time hash compare.
   */
  async verify(name: string, token: string): Promise<RelayDto> {
    const stored = await kv.get<RelayDto>(["relay", name], { consistency: "strong" });
    if (!stored.value) {
      log.warn(`❌ relay.verify: no relay configured for name=${name}`);
      throw new CanaryError("unauthorized", "Invalid relay token", 401);
    }
    const incoming = await sha256Hex(token);
    if (!constantTimeEqual(incoming, stored.value.tokenHash)) {
      log.warn(`❌ relay.verify: token mismatch for name=${name}`);
      throw new CanaryError("unauthorized", "Invalid relay token", 401);
    }
    log.debug(`✅ relay.verify: ok name=${name}`);
    return stored.value;
  }
}
