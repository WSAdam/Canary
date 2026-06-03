import { log } from "./_log.ts";

log.debug("🔍 kv: initializing Deno.openKv()...");
export const kv = await Deno.openKv();
log.debug("✅ kv: initialized successfully");
