import { Relay } from "../../impure/relay/relay.ts";
import { CanaryError } from "../../dto/_shared.ts";
import { log } from "../../impure/_log.ts";

export async function deleteRelay(input: { name: string }): Promise<{ ok: true }> {
  // kv.delete is an idempotent no-op for an absent/empty key, so the only thing
  // worth guarding is a non-string name reaching kv.delete as a key part (an
  // opaque 500). The route always passes a decoded string, so this is just a
  // safety net for any future non-route caller.
  if (typeof input.name !== "string") {
    throw new CanaryError("validation-error", "Relay name is required", 400);
  }
  await new Relay().delete(input.name);
  log.debug(`✅ relay.delete ${input.name}`);
  return { ok: true };
}
