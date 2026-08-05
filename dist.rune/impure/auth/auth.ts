import { kv } from "../_kv.ts";
import { CanaryError, constantTimeEqual, requireMaxLength, requireString } from "../../dto/_shared.ts";
import { log } from "../_log.ts";

// Bound the username so it can't blow past Deno KV's ~2 KiB key-size limit when
// used as the ["user", username] key part (a raw TypeError → opaque 500).
// Comfortably above any real email address.
const MAX_USERNAME_LENGTH = 320;

interface UserRecord {
  username: string;
  passwordHash: string;
  salt: string;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;

// A static dummy hash + salt so login()'s user-not-found branch can run an
// equivalent-cost PBKDF2 derivation. This closes the timing side channel that
// would otherwise let an attacker distinguish "unknown user" (no hashing) from
// "known user, wrong password" (full hashing) by response latency.
const DUMMY_SALT = "AAAAAAAAAAAAAAAAAAAAAA==";
const DUMMY_HASH = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/**
 * Enforce the server-side password policy: present, a string, and at least
 * MIN_PASSWORD_LENGTH characters. The SPA also checks this, but the API is the
 * authority — a direct caller must not be able to create an empty/weak account.
 */
export function validatePassword(password: unknown): string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new CanaryError(
      "validation-error",
      `Password is required and must be at least ${MIN_PASSWORD_LENGTH} characters`,
      400,
    );
  }
  return password;
}

// ---------------------------------------------------------------------------
// HMAC-signed stateless tokens — no KV read needed for validation
// ---------------------------------------------------------------------------

const SIGNING_KEY_KV = ["config", "session-signing-key"] as const;
let cachedSigningKey: Promise<CryptoKey> | null = null;

function importHmacKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// The session signing key is a random 256-bit secret persisted in Deno KV. It
// is generated once on first use (no env var required) and never falls back to
// a predictable constant. Cached per-isolate so it isn't re-read every request.
async function loadOrCreateSigningKey(): Promise<CryptoKey> {
  const existing = await kv.get<Uint8Array<ArrayBuffer>>(SIGNING_KEY_KV, { consistency: "strong" });
  if (existing.value) {
    log.debug("🔑 signingKey: loaded existing key from KV");
    return importHmacKey(existing.value);
  }
  const fresh = crypto.getRandomValues(new Uint8Array(32));
  const res = await kv.atomic()
    .check({ key: SIGNING_KEY_KV, versionstamp: null })
    .set(SIGNING_KEY_KV, fresh)
    .commit();
  if (res.ok) {
    log.info("🔑 signingKey: generated and persisted new key");
    return importHmacKey(fresh);
  }
  // Lost the first-boot race with another isolate — adopt the winning key.
  const winner = await kv.get<Uint8Array<ArrayBuffer>>(SIGNING_KEY_KV, { consistency: "strong" });
  if (!winner.value) {
    throw new CanaryError("internal-error", "Failed to establish session signing key", 500);
  }
  log.info("🔑 signingKey: adopted key written by another instance");
  return importHmacKey(winner.value);
}

function signingKey(): Promise<CryptoKey> {
  // Memoize the in-flight/resolved promise so the key isn't re-read every
  // request. But if that first load REJECTS (a transient KV hiccup, or losing
  // the create race with an empty re-read), clear the slot so the next call
  // retries instead of permanently re-awaiting the same rejected promise —
  // which would otherwise disable all login + session validation for the whole
  // life of this isolate.
  if (cachedSigningKey === null) {
    const p = loadOrCreateSigningKey();
    cachedSigningKey = p;
    p.catch((e) => {
      if (cachedSigningKey === p) cachedSigningKey = null;
      log.warn("⚠️ signingKey: load failed — cleared cache so it can retry:", (e as Error).message);
    });
  }
  return cachedSigningKey;
}

function b64u(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function fromb64u(s: string): Uint8Array<ArrayBuffer> {
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
  return constantTimeEqual(btoa(String.fromCharCode(...new Uint8Array(buf))), hash);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function seedAdmin(username: string, password: string): Promise<void> {
  log.debug("🔍 seedAdmin: checking:", username);
  const existing = await kv.get<UserRecord>(["user", username], { consistency: "strong" });
  if (existing.value !== null) { log.debug("🔍 seedAdmin: already exists"); return; }
  const { hash, salt } = await hashPassword(password);
  // Atomic claim: a plain check-then-set lets a concurrent boot (or a POST /users
  // racing seedAdmin for the same name) clobber the just-written row. If another
  // writer won, treat it as already-seeded.
  const res = await kv.atomic()
    .check({ key: ["user", username], versionstamp: null })
    .set(["user", username], { username, passwordHash: hash, salt })
    .commit();
  if (!res.ok) { log.debug("🔍 seedAdmin: lost create race — already exists"); return; }
  log.info("✅ seedAdmin: created:", username);
}

export async function login(username: string, password: string): Promise<{ token: string }> {
  // Validate up front so a missing/blank username doesn't reach kv.get() as an
  // undefined key part (which Deno KV rejects with a raw TypeError → 500).
  requireMaxLength(requireString(username, "username"), "username", MAX_USERNAME_LENGTH);
  if (typeof password !== "string") {
    throw new CanaryError("unauthorized", "Invalid credentials", 401);
  }
  log.debug("🔍 login: attempt for:", username);

  const entry = await kv.get<UserRecord>(["user", username], { consistency: "strong" });
  if (!entry.value) {
    log.warn("❌ login: user not found:", username);
    // Run an equivalent-cost dummy hash so the not-found path takes the same
    // time as the wrong-password path — defeats username enumeration by timing.
    await verifyPassword(password, DUMMY_HASH, DUMMY_SALT);
    throw new CanaryError("unauthorized", "Invalid credentials", 401);
  }
  const valid = await verifyPassword(password, entry.value.passwordHash, entry.value.salt);
  if (!valid) {
    log.warn("❌ login: wrong password for:", username);
    throw new CanaryError("unauthorized", "Invalid credentials", 401);
  }
  const token = await signToken(username);
  log.info("✅ login: signed token for:", username);
  return { token };
}

export async function logout(_token: string): Promise<void> {
  // Token is stateless — client clears it. Nothing to do server-side.
}

export async function validateSession(token: string): Promise<{ username: string }> {
  try {
    const result = await verifyToken(token);
    // Stateless tokens validate signature + expiry only, so a deleted user's
    // token would otherwise stay valid until expiry. Confirm the account still
    // exists in KV so DELETE /users actually revokes access immediately.
    const user = await kv.get<UserRecord>(["user", result.username], { consistency: "strong" });
    if (!user.value) {
      log.warn("❌ validateSession: token for deleted/unknown user:", result.username);
      throw new CanaryError("unauthorized", "Invalid or expired session", 401);
    }
    log.debug("✅ validateSession:", result.username);
    return result;
  } catch (e) {
    log.debug("❌ validateSession failed:", (e as Error).message);
    throw e;
  }
}

export async function createUser(username: string, password: string): Promise<void> {
  // Validate before any KV access: a missing/non-string username would reach
  // kv.get() as an invalid key part (raw TypeError → 500), and an empty/weak
  // password must be rejected server-side regardless of the SPA.
  requireMaxLength(requireString(username, "username"), "username", MAX_USERNAME_LENGTH);
  validatePassword(password);
  const existing = await kv.get<UserRecord>(["user", username], { consistency: "strong" });
  if (existing.value !== null) throw new CanaryError("conflict", `User '${username}' already exists`, 409);
  const { hash, salt } = await hashPassword(password);
  // Write atomically (check versionstamp:null) so two concurrent creates of the
  // same username can't both pass the existence check above and lose the first
  // password to the second's write — the loser gets the intended 409.
  const res = await kv.atomic()
    .check({ key: ["user", username], versionstamp: null })
    .set(["user", username], { username, passwordHash: hash, salt })
    .commit();
  if (!res.ok) throw new CanaryError("conflict", `User '${username}' already exists`, 409);
  log.info("✅ user created:", username);
}

export async function listUsers(): Promise<{ users: string[] }> {
  const users: string[] = [];
  for await (const entry of kv.list<UserRecord>({ prefix: ["user"] })) {
    users.push(entry.value.username);
  }
  return { users };
}

export async function deleteUser(username: string): Promise<void> {
  requireMaxLength(requireString(username, "username"), "username", MAX_USERNAME_LENGTH);
  let existing = await kv.get<UserRecord>(["user", username], { consistency: "strong" });
  if (!existing.value) throw new CanaryError("not-found", `User '${username}' not found`, 404);
  // Refuse to delete the last remaining account — doing so would leave KV with
  // zero user rows and make every future login impossible (recovery requires
  // re-seeding via env vars + a restart). Guards against a lockout footgun.
  //
  // The count check and the delete must be ATOMIC: two concurrent deletes of
  // different users, fired when exactly two remain, would both see length 2,
  // both pass the guard, and both delete → zero users. We only need to prove
  // that AT LEAST ONE other user survives our commit, so pin the versionstamp
  // of a SINGLE other user row (a "witness"): if a concurrent delete removes
  // that exact witness, our commit fails and we retry against a fresh set.
  // Pinning just one row (not every other row) keeps the atomic within Deno
  // KV's 100-check limit, so DELETE still works past 100 users — pinning every
  // row would throw "Too many checks (max 100)" and 500. Retry a few times so
  // an honest concurrent delete (not a lockout attempt) still succeeds.
  for (let attempt = 0; attempt < 5; attempt++) {
    let witness: { key: ["user", string]; versionstamp: string } | null = null;
    for await (const entry of kv.list<UserRecord>({ prefix: ["user"] }, { consistency: "strong" })) {
      const name = entry.key[1] as string;
      if (name === username) continue;
      witness = { key: ["user", name], versionstamp: entry.versionstamp };
      break; // one surviving witness is enough to prove this isn't the last user
    }
    // No other user ⇒ this is the last account ⇒ refuse.
    if (witness === null) {
      throw new CanaryError("validation-error", "Cannot delete the last remaining user", 400);
    }
    const res = await kv.atomic()
      .check({ key: ["user", username], versionstamp: existing.versionstamp })
      .check(witness)
      .delete(["user", username])
      .commit();
    if (res.ok) {
      log.info("✅ user deleted:", username);
      return;
    }
    log.warn(`⚠️ deleteUser: user set changed under us for "${username}" — retrying (attempt ${attempt + 1})`);
    existing = await kv.get<UserRecord>(["user", username], { consistency: "strong" });
    if (!existing.value) throw new CanaryError("not-found", `User '${username}' not found`, 404);
  }
  throw new CanaryError("conflict", "User set is changing concurrently — please retry", 409);
}
