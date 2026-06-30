import { Monitor } from "../../impure/monitor/monitor.ts";
import { kv } from "../../impure/_kv.ts";
import { purgeRelayMonitorKeys } from "../_shared/purgeRelayMonitorKeys.ts";
import { CanaryError } from "../../dto/_shared.ts";
import { log } from "../../impure/_log.ts";

/**
 * Delete a monitor of ANY type and everything scoped to it: run history, its
 * check/alert/webhook-secret/relay config and corrupt-ack, then the name index
 * and the monitor record. Named secrets (["secret", KEY]) are intentionally NOT
 * touched — they're shared resources another monitor may reference, managed in
 * the Secrets panel. Every delete is best-effort so one failure can't leave a
 * half-deleted monitor wedged.
 */
export async function deleteMonitor(input: { monitorId: string }): Promise<{ ok: true }> {
  if (typeof input.monitorId !== "string" || input.monitorId === "") {
    throw new CanaryError("validation-error", "monitorId is required", 400);
  }
  const monitor = await new Monitor().get(input.monitorId); // throws not-found

  // Run history first (strong consistency so a just-written row is visible and
  // swept, not orphaned under a now-deleted monitor).
  for (const prefix of [["run", input.monitorId], ["run_idx", input.monitorId]]) {
    for await (const entry of kv.list({ prefix }, { consistency: "strong" })) {
      try {
        await kv.delete(entry.key);
      } catch (e) {
        log.warn(`⚠️ monitor.delete: failed to drop run row (ignored): ${(e as Error).message}`);
      }
    }
  }
  // Per-monitor config rows keyed by monitorId.
  for (const key of [
    ["check", input.monitorId],
    ["alert", input.monitorId],
    ["webhook_secret", input.monitorId],
    ["run_corrupt_ack", input.monitorId],
  ]) {
    try {
      await kv.delete(key);
    } catch (e) {
      log.warn(`⚠️ monitor.delete: failed to drop ${key[0]} (ignored): ${(e as Error).message}`);
    }
  }
  // Relay config + name index + monitor record (shared key triple).
  await purgeRelayMonitorKeys(input.monitorId, monitor.name);
  log.debug(`✅ monitor.delete: removed ${monitor.type} monitor ${input.monitorId} ("${monitor.name}")`);
  return { ok: true };
}
