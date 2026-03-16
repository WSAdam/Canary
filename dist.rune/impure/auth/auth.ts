import { kv } from "../_kv.ts";
import { CanaryError } from "../../dto/_shared.ts";

interface UserRecord {
  username: string;
  passwordHash: string;
  salt: string;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

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
  const existing = await kv.get<UserRecord>(["user", username]);
  if (existing.value !== null) return;
  const { hash, salt } = await hashPassword(password);
  await kv.set(["user", username], { username, passwordHash: hash, salt });
  console.log("✅ admin seeded:", username);
}

export async function login(username: string, password: string): Promise<{ token: string }> {
  const entry = await kv.get<UserRecord>(["user", username]);
  if (!entry.value) throw new CanaryError("unauthorized", "Invalid credentials", 401);
  const valid = await verifyPassword(password, entry.value.passwordHash, entry.value.salt);
  if (!valid) throw new CanaryError("unauthorized", "Invalid credentials", 401);
  const token = crypto.randomUUID();
  await kv.set(["session", token], { username }, { expireIn: SESSION_TTL_MS });
  console.log("✅ login:", username);
  return { token };
}

export async function logout(token: string): Promise<void> {
  await kv.delete(["session", token]);
}

export async function validateSession(token: string): Promise<{ username: string }> {
  const entry = await kv.get<{ username: string }>(["session", token]);
  if (!entry.value) throw new CanaryError("unauthorized", "Invalid or expired session", 401);
  return entry.value;
}

export async function createUser(username: string, password: string): Promise<void> {
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
