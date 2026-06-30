import { Monitor } from "../../impure/monitor/monitor.ts";
import { deleteMonitor } from "../monitor-delete/monitor-delete.ts";
import { CanaryError } from "../../dto/_shared.ts";

/**
 * Delete a relay monitor via the relay-scoped endpoint. Type-guarded to "relay"
 * so DELETE /relays/:id can't become a back door for deleting check monitors;
 * the actual teardown is the shared deleteMonitor (record, config, run history).
 */
export async function deleteRelay(input: { monitorId: string }): Promise<{ ok: true }> {
  if (typeof input.monitorId !== "string" || input.monitorId === "") {
    throw new CanaryError("validation-error", "monitorId is required", 400);
  }
  const monitor = await new Monitor().get(input.monitorId); // throws not-found
  if (monitor.type !== "relay") {
    throw new CanaryError("validation-error", `Monitor "${input.monitorId}" is not a relay`, 400);
  }
  return deleteMonitor({ monitorId: input.monitorId });
}
