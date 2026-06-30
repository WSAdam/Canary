import type { CreateRelayDto } from "../../dto/create-relay-dto.ts";
import { createMonitor } from "../monitor-create/monitor-create.ts";
import { configureRelay } from "../relay-configure/relay-configure.ts";
import { kv } from "../../impure/_kv.ts";
import { log } from "../../impure/_log.ts";

export interface RelayCreateResult {
  monitorId: string;
  name: string;
}

/** Provision a relay end-to-end: a monitor of type "relay" plus its relay
 *  config, in one call. Best-effort rollback of the monitor if the relay config
 *  fails to validate/persist (Deno KV has no multi-key transaction). */
export async function createRelayMonitor(input: CreateRelayDto): Promise<RelayCreateResult> {
  log.info(`📮 relay.createMonitor: name="${input?.name}"`);

  // 1. Monitor (validates + enforces name uniqueness via an atomic KV check).
  const monitor = await createMonitor({
    name: input?.name,
    description: typeof input?.description === "string" ? input.description : "",
    type: "relay",
  });

  // 2. Relay config (numbers + token + optional template). On failure, roll back
  //    the monitor so a half-provisioned relay (a monitor with no config) can't
  //    linger in the list.
  try {
    await configureRelay({
      monitorId: monitor.monitorId,
      numbers: input?.numbers,
      token: input?.token,
      template: input?.template,
    });
  } catch (err) {
    log.warn(`⚠️ relay.createMonitor: config failed for "${monitor.name}" — rolling back: ${(err as Error).message}`);
    for (const op of [
      () => kv.delete(["monitor", monitor.monitorId]),
      () => kv.delete(["monitor_name", monitor.name]),
      () => kv.delete(["relay", monitor.monitorId]),
    ]) {
      try {
        await op();
      } catch (e) {
        log.warn(`⚠️ relay.createMonitor: rollback step failed (ignored): ${(e as Error).message}`);
      }
    }
    throw err;
  }

  log.info(`✅ relay.createMonitor: "${monitor.name}" monitorId=${monitor.monitorId}`);
  return { monitorId: monitor.monitorId, name: monitor.name };
}
