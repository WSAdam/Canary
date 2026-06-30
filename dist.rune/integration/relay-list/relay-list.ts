import type { RelayListDto } from "../../dto/relay-list-dto.ts";
import { Relay } from "../../impure/relay/relay.ts";
import { log } from "../../impure/_log.ts";

export async function listRelays(): Promise<RelayListDto> {
  const result = await new Relay().list();
  log.debug(`✅ relay.list count=${result.relays.length}`);
  return result;
}
