import { kv } from "../_kv.ts";
import { CanaryError, constantTimeEqual } from "../../dto/_shared.ts";
import type { RelayDto, RelayPublicDto } from "../../dto/relay-dto.ts";
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

/** Strip the token hash before a relay config leaves the server. */
function toPublic(dto: RelayDto): RelayPublicDto {
  return { numbers: dto.numbers, hasTemplate: !!dto.template, createdAt: dto.createdAt };
}

// Relay config is keyed by the owning monitor's id — a relay IS a monitor of
// type "relay", so its config lives alongside the monitor (["relay", monitorId])
// rather than under a separate name namespace.
export class Relay {
  /** Hash a plaintext token for storage/compare. */
  static hash(token: string): Promise<string> {
    return sha256Hex(token);
  }

  /** Create or replace the relay config for a monitor. */
  async upsert(monitorId: string, numbers: string[], tokenHash: string, template?: string): Promise<RelayPublicDto> {
    const dto: RelayDto = { numbers, template, tokenHash, createdAt: new Date().toISOString() };
    await kv.set(["relay", monitorId], dto);
    log.debug(`📮 relay.upsert: monitorId=${monitorId} numbers=${numbers.length}`);
    return toPublic(dto);
  }

  /** Read the relay config (token hash stripped), or throw not-found. */
  async get(monitorId: string): Promise<RelayPublicDto> {
    const stored = await this.peek(monitorId);
    if (!stored) throw new CanaryError("not-found", `Relay config for monitor "${monitorId}" not found`, 404);
    return toPublic(stored);
  }

  /** Read the raw relay config including the token hash, or null. Server-side
   *  only — never expose the hash over the API. */
  async peek(monitorId: string): Promise<RelayDto | null> {
    const stored = await kv.get<RelayDto>(["relay", monitorId], { consistency: "strong" });
    return stored.value;
  }

  async delete(monitorId: string): Promise<void> {
    await kv.delete(["relay", monitorId]);
    log.debug(`📮 relay.delete: monitorId=${monitorId}`);
  }

  /**
   * Authenticate a fire request and return the stored config (numbers + template)
   * on success. A monitor with no relay config and a wrong token both surface the
   * same 401 so a caller can't probe which monitors are relays. Constant-time
   * hash compare.
   */
  async verify(monitorId: string, token: string): Promise<RelayDto> {
    const stored = await this.peek(monitorId);
    if (!stored) {
      log.warn(`❌ relay.verify: no relay config for monitorId=${monitorId}`);
      throw new CanaryError("unauthorized", "Invalid relay token", 401);
    }
    const incoming = await sha256Hex(token);
    if (!constantTimeEqual(incoming, stored.tokenHash)) {
      log.warn(`❌ relay.verify: token mismatch for monitorId=${monitorId}`);
      throw new CanaryError("unauthorized", "Invalid relay token", 401);
    }
    log.debug(`✅ relay.verify: ok monitorId=${monitorId}`);
    return stored;
  }
}
