import { BaseSource } from "../../shared/mod.ts";
import type { CheckDto } from "../../../../dto/check-dto.ts";
import type { ResponseDto } from "../../../../dto/response-dto.ts";
import { CanaryError } from "../../../../dto/_shared.ts";

const RETRY_DELAYS = [0, 2000, 5000]; // immediate, 2s, 5s

export class Http extends BaseSource {
  async fetch(dto: CheckDto): Promise<ResponseDto> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
      if (RETRY_DELAYS[attempt] > 0) {
        console.log(`🔄 http.fetch: retry attempt ${attempt + 1} after ${RETRY_DELAYS[attempt]}ms delay — url=${dto.url}`);
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      }

      try {
        const response = await fetch(dto.url, {
          method: dto.method,
          headers: { "Content-Type": "application/json", ...dto.headers },
          body: dto.method !== "GET" && dto.body ? dto.body : undefined,
        });

        if (!response.ok) {
          lastError = new CanaryError("request-failed", `HTTP ${response.status} from ${dto.url}`, 502);
          console.log(`⚠️ http.fetch: attempt ${attempt + 1} failed — HTTP ${response.status}`);
          continue;
        }

        const payload = await response.text();
        if (attempt > 0) console.log(`✅ http.fetch: succeeded on attempt ${attempt + 1}`);
        return { payload };
      } catch (e) {
        lastError = new CanaryError("request-failed", `Failed to reach ${dto.url}: ${(e as Error).message}`, 502);
        console.log(`⚠️ http.fetch: attempt ${attempt + 1} failed — ${(e as Error).message}`);
      }
    }

    throw lastError ?? new CanaryError("request-failed", `All retries failed for ${dto.url}`, 502);
  }
}
