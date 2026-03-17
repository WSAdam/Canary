import { kv } from "../_kv.ts";
import { CanaryError } from "../../dto/_shared.ts";

interface UserRecord {
  username: string;
  passwordHash: string;
  salt: string;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function tok(t: string) {
  return t.slice(0, 8) + "...";
}

async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return {
    hash: btoa(String.fromCharCode(...new Uint8Array(hashBuffer))),
    salt: btoa(String.fromCharCode(...saltBytes)),
  };
}

async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const saltBytes = Uint8Array.from(atob(salt), (c) => c.charCodeAt(0));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  const computed = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
  return computed === hash;
}

export async function seedAdmin(username: string, password: string): Promise<void> {
  console.log("🔍 seedAdmin: checking for existing user:", username);
  const existing = await kv.get<UserRecord>(["user", username], { consistency: "strong" });
  if (existing.value !== null) {
    console.log("🔍 seedAdmin: user already exists, skipping");
    return;
  }
  const { hash, salt } = await hashPassword(password);
  await kv.set(["user", username], { username, passwordHash: hash, salt });
  console.log("✅ seedAdmin: admin created:", username);
}

export async function login(username: string, password: string): Promise<{ token: string }> {
  console.log("🔍 login: attempt for:", username);
  const entry = await kv.get<UserRecord>(["user", username], { consistency: "strong" });
  if (!entry.value) {
    console.log("❌ login: user not found in KV:", username);
    throw new CanaryError("unauthorized", "Invalid credentials", 401);
  }
  console.log("🔍 login: user found, verifying password");
  const valid = await verifyPassword(password, entry.value.passwordHash, entry.value.salt);
  if (!valid) {
    console.log("❌ login: password mismatch for:", username);
    throw new CanaryError("unauthorized", "Invalid credentials", 401);
  }
  const token = crypto.randomUUID();
  console.log("🔍 login: writing session to KV, token:", tok(token));
  await kv.set(["session", token], { username }, { expireIn: SESSION_TTL_MS });
  // Verify it was written
  const check = await kv.get(["session", token]);
  if (!check.value) {
    console.log("❌ login: session write FAILED — KV returned null immediately after set");
  } else {
    console.log("✅ login: session confirmed in KV for:", username);
  }
  return { token };
}

export async function logout(token: string): Promise<void> {
  console.log("🔍 logout: deleting session:", tok(token));
  await kv.delete(["session", token]);
}

export async function validateSession(token: string): Promise<{ username: string }> {
  console.log("🔍 validateSession: looking up token:", tok(token));
  const entry = await kv.get<{ username: string }>(["session", token], { consistency: "strong" });
  if (!entry.value) {
    console.log("❌ validateSession: session not found for token:", tok(token));
    throw new CanaryError("unauthorized", "Invalid or expired session", 401);
  }
  console.log("✅ validateSession: valid session for:", entry.value.username);
  return entry.value;
}

export async function createUser(username: string, password: string): Promise<void> {
  console.log("🔍 createUser:", username);
  const existing = await kv.get<UserRecord>(["user", username]);
  if (existing.value !== null) {
    throw new CanaryError("conflict", `User '${username}' already exists`, 409);
  }
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
  const existing = await kv.get<UserRecord>(["user", username]);
  if (!existing.value) throw new CanaryError("not-found", `User '${username}' not found`, 404);
  await kv.delete(["user", username]);
  console.log("✅ user deleted:", username);
}
