import { BaseSource } from "../../shared/mod.ts";
import type { CheckDto } from "../../../../dto/check-dto.ts";
import type { ResponseDto } from "../../../../dto/response-dto.ts";
import { CanaryError, type ResponseDetailCarrier } from "../../../../dto/_shared.ts";
import { log } from "../../../_log.ts";

const RETRY_DELAYS = [0, 2000, 5000]; // immediate, 2s, 5s
// Per-request wall-clock cap so a hung/slow endpoint can't stall the runner.
const TIMEOUT_MS = Number(Deno.env.get("FETCH_TIMEOUT_MS")) || 10000;

export class Http extends BaseSource {
  async fetch(dto: CheckDto, secretValues: string[] = []): Promise<ResponseDto> {
    // Scrub resolved secret values from anything we log or throw — including
    // the URL we build AND the runtime's own fetch error message, which embeds
    // the full resolved URL (query + path).
    const redact = (s: string) =>
      secretValues.reduce((acc, v) => (v ? acc.split(v).join("***") : acc), s);
    const url = redact(dto.url);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
      if (RETRY_DELAYS[attempt] > 0) {
        log.warn(`🔄 http.fetch: retry attempt ${attempt + 1} after ${RETRY_DELAYS[attempt]}ms delay — url=${url}`);
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      }

      try {
        const response = await fetch(dto.url, {
          method: dto.method,
          headers: { "Content-Type": "application/json", ...dto.headers },
          body: dto.method !== "GET" && dto.body ? dto.body : undefined,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (!response.ok) {
          // Keep the body so a failed run can show what the endpoint returned.
          const errBody = redact(await response.text().catch(() => ""));
          const err: CanaryError & ResponseDetailCarrier = new CanaryError(
            "request-failed",
            `HTTP ${response.status} from ${url}`,
            502,
          );
          err.responseStatus = response.status;
          err.responseBody = errBody;
          lastError = err;
          log.warn(`⚠️ http.fetch: attempt ${attempt + 1} failed — HTTP ${response.status}`);
          continue;
        }

        const payload = await response.text();
        if (attempt > 0) log.info(`✅ http.fetch: succeeded on attempt ${attempt + 1}`);
        return { payload, status: response.status };
      } catch (e) {
        const err = e as Error;
        if (err.name === "TimeoutError" || err.name === "AbortError") {
          lastError = new CanaryError("timed-out", `Timed out after ${TIMEOUT_MS}ms reaching ${url}`, 504);
          log.warn(`⚠️ http.fetch: attempt ${attempt + 1} timed out after ${TIMEOUT_MS}ms`);
        } else {
          lastError = new CanaryError("request-failed", `Failed to reach ${url}`, 502);
          log.warn(`⚠️ http.fetch: attempt ${attempt + 1} failed — ${redact(err.message)}`);
        }
      }
    }

    throw lastError ?? new CanaryError("request-failed", `All retries failed for ${url}`, 502);
  }
}
