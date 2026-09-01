import { log } from "./_log.ts";

// CANARY_KV_PATH overrides where KV lives — the test task sets ":memory:" so
// the suite is hermetic: the shared on-disk store accumulates rows across Deno
// versions, and a V8 downgrade turns them into "could not deserialize value"
// on every list. Unset (production/dev) keeps the platform default store.
const kvPath = Deno.env.get("CANARY_KV_PATH") || undefined;
log.debug(`🔍 kv: initializing Deno.openKv(${kvPath ? `"${kvPath}"` : ""})...`);
export const kv = await Deno.openKv(kvPath);
log.debug("✅ kv: initialized successfully");
