import { kv } from "../_kv.ts";
import { CanaryError, constantTimeEqual } from "../../dto/_shared.ts";
import type { WebhookSecretDto } from "../../dto/webhook-secret-dto.ts";
import { log } from "../_log.ts";

const PREFIX = "cnry_v1_";
const SECRET_BYTES = 32;

function b64u(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(digest);
}

export interface GeneratedSecret {
  plaintext: string;
  fingerprint: string;
  createdAt: string;
}

export class WebhookSecret {
  static async generate(monitorId: string): Promise<GeneratedSecret> {
    // Mint + persist atomically. Two concurrent generate/rotate calls each
    // return their own plaintext to their caller, but a plain kv.set is
    // last-write-wins: the losing caller is told to "save this secret" yet its
    // hash is never the one persisted, so that secret authenticates 401 forever.
    // Pin the versionstamp we read and retry on conflict so the plaintext we
    // hand back is guaranteed to be the one whose hash actually landed in KV.
    const key = ["webhook_secret", monitorId] as const;
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await kv.get<WebhookSecretDto>(key, { consistency: "strong" });

      const randomBytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
      const plaintext = PREFIX + b64u(randomBytes.buffer as ArrayBuffer);
      const hash = await sha256Hex(plaintext);
      const fingerprint = plaintext.slice(0, PREFIX.length + 4); // cnry_v1_XXXX
      const createdAt = new Date().toISOString();

      const dto: WebhookSecretDto = { hash, fingerprint, createdAt };
      const res = await kv.atomic()
        .check({ key, versionstamp: current.versionstamp })
        .set(key, dto)
        .commit();
      if (res.ok) {
        log.debug(`🪝 webhookSecret.generate: monitorId=${monitorId} fingerprint=${fingerprint}`);
        return { plaintext, fingerprint, createdAt };
      }
      log.warn(`⚠️ webhookSecret.generate: concurrent write for monitorId=${monitorId} — retrying (attempt ${attempt + 1})`);
    }
    throw new CanaryError("conflict", "Webhook key is being changed concurrently — please retry", 409);
  }

  static async verify(monitorId: string, plaintext: string): Promise<void> {
    const stored = await kv.get<WebhookSecretDto>(["webhook_secret", monitorId], { consistency: "strong" });
    if (!stored.value) {
      log.warn(`❌ webhookSecret.verify: no key configured for monitorId=${monitorId}`);
      throw new CanaryError("unauthorized", "Invalid webhook key", 401);
    }
    const incoming = await sha256Hex(plaintext);
    if (!constantTimeEqual(incoming, stored.value.hash)) {
      log.warn(`❌ webhookSecret.verify: key mismatch for monitorId=${monitorId}`);
      throw new CanaryError("unauthorized", "Invalid webhook key", 401);
    }
    log.debug(`✅ webhookSecret.verify: ok monitorId=${monitorId} fingerprint=${stored.value.fingerprint}`);
  }

  static async peek(monitorId: string): Promise<{ exists: boolean; fingerprint?: string; createdAt?: string }> {
    const stored = await kv.get<WebhookSecretDto>(["webhook_secret", monitorId], { consistency: "strong" });
    if (!stored.value) return { exists: false };
    return { exists: true, fingerprint: stored.value.fingerprint, createdAt: stored.value.createdAt };
  }

  static async revoke(monitorId: string): Promise<void> {
    await kv.delete(["webhook_secret", monitorId]);
    log.debug(`🪝 webhookSecret.revoke: monitorId=${monitorId}`);
  }
}
