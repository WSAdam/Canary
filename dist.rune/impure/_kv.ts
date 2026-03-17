console.log("🔍 kv: initializing Deno.openKv()...");
export const kv = await Deno.openKv();
console.log("✅ kv: initialized successfully");
