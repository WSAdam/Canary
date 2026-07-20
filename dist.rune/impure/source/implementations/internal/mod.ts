import { BaseSource } from "../../shared/mod.ts";
import type { CheckDto } from "../../../../dto/check-dto.ts";
import type { ResponseDto } from "../../../../dto/response-dto.ts";
import { CanaryError } from "../../../../dto/_shared.ts";
import { log } from "../../../_log.ts";
import { getDenoUsage } from "../../../../integration/deno-usage/deno-usage.ts";
import { getDenoSpend } from "../../../../integration/deno-spend/deno-spend.ts";

// Checks that read data Canary produces ITSELF rather than from a remote
// endpoint. A deployment cannot HTTP-fetch its own hostname — Deno Deploy
// answers 508 Loop Detected — so a check pointed at Canary's own /api/deno-*
// route can never run. These producers are therefore called IN-PROCESS.
//
// Beyond dodging the loop, this is the better shape: no network hop, no bearer
// secret to store and rotate, and the data never leaves the isolate.
//
// URL form:  internal:<producer>[?params]   e.g. internal:deno-usage?hours=24
export const SCHEME = "internal:";

/** Producers callable as `internal:<name>`. Each returns a JSON-serializable
 *  object, which becomes the check's response payload (so the ordinary
 *  expression/comparator/captures machinery works against it unchanged). */
const PRODUCERS: Record<string, (params: URLSearchParams) => Promise<unknown>> = {
  // Window params (?hours= / ?day= / ?from=&to=) are resolved by the producer.
  "deno-usage": (params) => getDenoUsage(params),
  "deno-spend": () => getDenoSpend(),
};

export function isInternalUrl(url: string): boolean {
  return typeof url === "string" && url.trimStart().toLowerCase().startsWith(SCHEME);
}

/** Split `internal:<producer>?a=b` into its producer name and query params.
 *  Throws a 400 naming the valid producers when the name is unknown — a typo
 *  should fail loudly at run time, not silently return nothing. */
export function parseInternalUrl(url: string): { name: string; params: URLSearchParams } {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new CanaryError("validation-error", `Invalid internal URL: "${url}"`, 400);
  }
  if (parsed.protocol !== SCHEME) {
    throw new CanaryError("validation-error", `Not an internal URL: "${url}"`, 400);
  }
  // Tolerate `internal:name` and `internal:/name` / `internal://name` alike.
  const name = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "") || parsed.hostname;
  if (!Object.hasOwn(PRODUCERS, name)) {
    throw new CanaryError(
      "validation-error",
      `Unknown internal producer "${name}" — expected one of: ${Object.keys(PRODUCERS).join(", ")}`,
      400,
    );
  }
  return { name, params: parsed.searchParams };
}

/** Run an internal producer and return its result as a synthetic 200 response.
 *  Shared by the runner and the wizard's Test request button. */
export async function runInternal(url: string): Promise<ResponseDto> {
  const { name, params } = parseInternalUrl(url);
  log.info(`🔍 internal.fetch: running producer "${name}"`);
  const data = await PRODUCERS[name](params);
  return { payload: JSON.stringify(data), status: 200 };
}

export class Internal extends BaseSource {
  // No retries: these producers already retry/fail-fast against their own
  // upstreams, and a config error (unknown producer, missing env) is not
  // transient — re-running it would only delay the same failure.
  fetch(dto: CheckDto): Promise<ResponseDto> {
    return runInternal(dto.url);
  }
}
