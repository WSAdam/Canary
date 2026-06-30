import { kv } from "../../impure/_kv.ts";
import { log } from "../../impure/_log.ts";

/**
 * Best-effort delete of a relay monitor's defining keys (relay config, name
 * index, monitor record) — the single source of truth for what keys a relay
 * owns, shared by relay-delete and relay-create's rollback. Per-op failures are
 * logged and swallowed so cleanup never masks the caller's error. Run history is
 * swept separately, by the full-delete path only.
 */
export async function purgeRelayMonitorKeys(monitorId: string, name: string): Promise<void> {
  for (const op of [
    () => kv.delete(["relay", monitorId]),
    () => kv.delete(["monitor_name", name]),
    () => kv.delete(["monitor", monitorId]),
  ]) {
    try {
      await op();
    } catch (e) {
      log.warn(`⚠️ purgeRelayMonitorKeys: step failed (ignored): ${(e as Error).message}`);
    }
  }
}
