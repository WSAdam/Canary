import { Monitor } from "../../impure/monitor/monitor.ts";
import { kv } from "../../impure/_kv.ts";
import { purgeRelayMonitorKeys } from "../_shared/purgeRelayMonitorKeys.ts";
import { CanaryError } from "../../dto/_shared.ts";
import { log } from "../../impure/_log.ts";

// The single source of truth for what a monitor owns, so the delete path and its
// test can't drift. SCOPED_KEYS are single per-monitor rows; RUN_PREFIXES are
// the history partitions to scan. The monitor record + name index + relay config
// are handled by purgeRelayMonitorKeys. Named secrets (["secret", KEY]) are
// deliberately excluded — they're shared resources another monitor may reference.
export const MONITOR_SCOPED_KEYS = (monitorId: string): Deno.KvKey[] => [
  ["check", monitorId],
  ["alert", monitorId],
  ["webhook_secret", monitorId],
  ["run_corrupt_ack", monitorId],
];
export const MONITOR_RUN_PREFIXES = (monitorId: string): Deno.KvKey[] => [
  ["run", monitorId],
  ["run_idx", monitorId],
];

async function bestEffortDelete(key: Deno.KvKey, label: string): Promise<void> {
  try {
    await kv.delete(key);
  } catch (e) {
    log.warn(`⚠️ monitor.delete: failed to drop ${label} (ignored): ${(e as Error).message}`);
  }
}

/**
 * Delete a monitor of ANY type and everything scoped to it: run history, its
 * check/alert/webhook-secret/relay config and corrupt-ack, then the name index
 * and the monitor record. Every delete is best-effort so one failure can't leave
 * a half-deleted monitor wedged.
 */
export async function deleteMonitor(input: { monitorId: string }): Promise<{ ok: true }> {
  if (typeof input.monitorId !== "string" || input.monitorId === "") {
    throw new CanaryError("validation-error", "monitorId is required", 400);
  }
  const monitor = await new Monitor().get(input.monitorId); // throws not-found

  // Run history first, strong-consistency so a just-written row is visible and
  // swept, not orphaned under a now-deleted monitor.
  for (const prefix of MONITOR_RUN_PREFIXES(input.monitorId)) {
    for await (const entry of kv.list({ prefix }, { consistency: "strong" })) {
      await bestEffortDelete(entry.key, "run row");
    }
  }
  for (const key of MONITOR_SCOPED_KEYS(input.monitorId)) {
    await bestEffortDelete(key, key[0] as string);
  }
  // Relay config + name index + monitor record (shared key triple).
  await purgeRelayMonitorKeys(input.monitorId, monitor.name);
  log.debug(`✅ monitor.delete: removed ${monitor.type} monitor ${input.monitorId} ("${monitor.name}")`);
  return { ok: true };
}
