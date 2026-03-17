import { kv } from "../_kv.ts";
import { CanaryError } from "../../dto/_shared.ts";

interface UserRecord {
  username: string;
  passwordHash: string;
  salt: string;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// HMAC-signed stateless tokens — no KV read needed for validation
// ---------------------------------------------------------------------------

async function signingKey(): Promise<CryptoKey> {
  // Derive a secret from existing env vars so no new config is required.
  const raw = [
    Deno.env.get("POSTMARK_SERVER_TOKEN"),
    Deno.env.get("ADMIN_PASSWORD"),
    "canary-v1",
  ].filter(Boolean).join("|");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(raw),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function b64u(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function fromb64u(s: string): Uint8Array {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(padded.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

async function signToken(username: string): Promise<string> {
  const payload = b64u(new TextEncoder().encode(JSON.stringify({ u: username, e: Date.now() + SESSION_TTL_MS })));
  const key = await signingKey();
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return payload + "." + b64u(sig);
}

async function verifyToken(token: string): Promise<{ username: string }> {
  const dot = token.lastIndexOf(".");
  if (dot === -1) throw new CanaryError("unauthorized", "Invalid or expired session", 401);
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const key = await signingKey();
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify("HMAC", key, fromb64u(sig), new TextEncoder().encode(payload));
  } catch {
    throw new CanaryError("unauthorized", "Invalid or expired session", 401);
  }
  if (!valid) throw new CanaryError("unauthorized", "Invalid or expired session", 401);
  let data: { u: string; e: number };
  try {
    data = JSON.parse(new TextDecoder().decode(fromb64u(payload)));
  } catch {
    throw new CanaryError("unauthorized", "Invalid or expired session", 401);
  }
  if (Date.now() > data.e) throw new CanaryError("unauthorized", "Session expired", 401);
  return { username: data.u };
}

// ---------------------------------------------------------------------------
// Password hashing (PBKDF2)
// ---------------------------------------------------------------------------

async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const buf = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: saltBytes, iterations: 100000, hash: "SHA-256" }, key, 256);
  return {
    hash: btoa(String.fromCharCode(...new Uint8Array(buf))),
    salt: btoa(String.fromCharCode(...saltBytes)),
  };
}

async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const saltBytes = Uint8Array.from(atob(salt), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const buf = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: saltBytes, iterations: 100000, hash: "SHA-256" }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(buf))) === hash;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function seedAdmin(username: string, password: string): Promise<void> {
  console.log("🔍 seedAdmin: checking:", username);
  const existing = await kv.get<UserRecord>(["user", username], { consistency: "strong" });
  if (existing.value !== null) { console.log("🔍 seedAdmin: already exists"); return; }
  const { hash, salt } = await hashPassword(password);
  await kv.set(["user", username], { username, passwordHash: hash, salt });
  console.log("✅ seedAdmin: created:", username);
}

export async function login(username: string, password: string): Promise<{ token: string }> {
  console.log("🔍 login: attempt for:", username);
  const entry = await kv.get<UserRecord>(["user", username], { consistency: "strong" });
  if (!entry.value) {
    console.log("❌ login: user not found:", username);
    throw new CanaryError("unauthorized", "Invalid credentials", 401);
  }
  const valid = await verifyPassword(password, entry.value.passwordHash, entry.value.salt);
  if (!valid) {
    console.log("❌ login: wrong password for:", username);
    throw new CanaryError("unauthorized", "Invalid credentials", 401);
  }
  const token = await signToken(username);
  console.log("✅ login: signed token for:", username);
  return { token };
}

export async function logout(_token: string): Promise<void> {
  // Token is stateless — client clears it. Nothing to do server-side.
}

export async function validateSession(token: string): Promise<{ username: string }> {
  try {
    const result = await verifyToken(token);
    console.log("✅ validateSession:", result.username);
    return result;
  } catch (e) {
    console.log("❌ validateSession failed:", (e as Error).message);
    throw e;
  }
}

export async function createUser(username: string, password: string): Promise<void> {
  const existing = await kv.get<UserRecord>(["user", username], { consistency: "strong" });
  if (existing.value !== null) throw new CanaryError("conflict", `User '${username}' already exists`, 409);
  const { hash, salt } = await hashPassword(password);
  await kv.set(["user", username], { username, passwordHash: hash, salt });
  console.log("✅ user created:", username);
}

export async function listUsers(): Promise<{ users: string[] }> {
  const users: string[] = [];
  for await (const entry of kv.list<UserRecord>({ prefix: ["user"] })) {
    users.push(entry.value.username);
  }
  return { users };
}

export async function deleteUser(username: string): Promise<void> {
  const existing = await kv.get<UserRecord>(["user", username], { consistency: "strong" });
  if (!existing.value) throw new CanaryError("not-found", `User '${username}' not found`, 404);
  await kv.delete(["user", username]);
  console.log("✅ user deleted:", username);
}
