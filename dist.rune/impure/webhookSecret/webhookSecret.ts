import { kv } from "../_kv.ts";
import { CanaryError, constantTimeEqual } from "../../dto/_shared.ts";
import type { WebhookSecretDto } from "../../dto/webhook-secret-dto.ts";

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
    const randomBytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
    const plaintext = PREFIX + b64u(randomBytes.buffer as ArrayBuffer);
    const hash = await sha256Hex(plaintext);
    const fingerprint = plaintext.slice(0, PREFIX.length + 4); // cnry_v1_XXXX
    const createdAt = new Date().toISOString();

    const dto: WebhookSecretDto = { hash, fingerprint, createdAt };
    await kv.set(["webhook_secret", monitorId], dto);
    console.log(`🪝 webhookSecret.generate: monitorId=${monitorId} fingerprint=${fingerprint}`);
    return { plaintext, fingerprint, createdAt };
  }

  static async verify(monitorId: string, plaintext: string): Promise<void> {
    const stored = await kv.get<WebhookSecretDto>(["webhook_secret", monitorId], { consistency: "strong" });
    if (!stored.value) {
      console.log(`❌ webhookSecret.verify: no key configured for monitorId=${monitorId}`);
      throw new CanaryError("unauthorized", "Invalid webhook key", 401);
    }
    const incoming = await sha256Hex(plaintext);
    if (!constantTimeEqual(incoming, stored.value.hash)) {
      console.log(`❌ webhookSecret.verify: key mismatch for monitorId=${monitorId}`);
      throw new CanaryError("unauthorized", "Invalid webhook key", 401);
    }
    console.log(`✅ webhookSecret.verify: ok monitorId=${monitorId} fingerprint=${stored.value.fingerprint}`);
  }

  static async peek(monitorId: string): Promise<{ exists: boolean; fingerprint?: string; createdAt?: string }> {
    const stored = await kv.get<WebhookSecretDto>(["webhook_secret", monitorId], { consistency: "strong" });
    if (!stored.value) return { exists: false };
    return { exists: true, fingerprint: stored.value.fingerprint, createdAt: stored.value.createdAt };
  }

  static async revoke(monitorId: string): Promise<void> {
    await kv.delete(["webhook_secret", monitorId]);
    console.log(`🪝 webhookSecret.revoke: monitorId=${monitorId}`);
  }
}
