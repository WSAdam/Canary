import { Relay } from "../../impure/relay/relay.ts";
import { CanaryError } from "../../dto/_shared.ts";
import { log } from "../../impure/_log.ts";

export async function deleteRelay(input: { name: string }): Promise<{ ok: true }> {
  if (typeof input.name !== "string" || input.name.trim() === "") {
    throw new CanaryError("validation-error", "Relay name is required", 400);
  }
  await new Relay().delete(input.name);
  log.debug(`✅ relay.delete ${input.name}`);
  return { ok: true };
}
