import { kv } from "../../impure/_kv.ts";
import { log } from "../../impure/_log.ts";

/**
 * Best-effort deletion of the key triple that defines a relay monitor: the
 * monitor record, its name-uniqueness index, and its relay config. The single
 * source of truth for "what keys a relay monitor owns" — used by both
 * relay-delete (full delete) and relay-create's rollback (undo a half-built
 * relay). Run history (["run"|"run_idx", monitorId]) is intentionally NOT swept
 * here: only the full-delete path needs it, and a just-created relay (the
 * rollback case) has fired nothing yet. Per-op failures are logged and ignored
 * so cleanup never masks the caller's original error.
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
