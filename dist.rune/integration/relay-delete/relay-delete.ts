import { Monitor } from "../../impure/monitor/monitor.ts";
import { Relay } from "../../impure/relay/relay.ts";
import { kv } from "../../impure/_kv.ts";
import { CanaryError } from "../../dto/_shared.ts";
import { log } from "../../impure/_log.ts";

/**
 * Delete a relay monitor in full: its monitor record, name-uniqueness index,
 * relay config, and run history. Scoped to type "relay" so this can't become a
 * back-door delete for check monitors (which intentionally have no delete path).
 */
export async function deleteRelay(input: { monitorId: string }): Promise<{ ok: true }> {
  if (typeof input.monitorId !== "string" || input.monitorId === "") {
    throw new CanaryError("validation-error", "monitorId is required", 400);
  }
  const monitor = await new Monitor().get(input.monitorId); // throws not-found
  if (monitor.type !== "relay") {
    throw new CanaryError("validation-error", `Monitor "${input.monitorId}" is not a relay`, 400);
  }

  // Drop run history first (best-effort, per-row) so a relay's rows don't linger
  // orphaned in KV; then the config, name index, and monitor record.
  for (const prefix of [["run", input.monitorId], ["run_idx", input.monitorId]]) {
    for await (const entry of kv.list({ prefix })) {
      try {
        await kv.delete(entry.key);
      } catch (e) {
        log.warn(`⚠️ relay.delete: failed to drop run row (ignored): ${(e as Error).message}`);
      }
    }
  }
  await new Relay().delete(input.monitorId);
  await kv.delete(["monitor_name", monitor.name]);
  await kv.delete(["monitor", input.monitorId]);
  log.debug(`✅ relay.delete: removed relay monitor ${input.monitorId} ("${monitor.name}")`);
  return { ok: true };
}
