import { BaseSource } from "../../shared/mod.ts";
import type { CheckDto } from "../../../../dto/check-dto.ts";
import type { ResponseDto } from "../../../../dto/response-dto.ts";
import { CanaryError } from "../../../../dto/_shared.ts";

export class Http extends BaseSource {
  async fetch(dto: CheckDto): Promise<ResponseDto> {
    let response: Response;
    try {
      response = await fetch(dto.url, {
        method: dto.method,
        headers: dto.headers,
        body: dto.method !== "GET" && dto.body ? dto.body : undefined,
      });
    } catch (e) {
      throw new CanaryError(
        "request-failed",
        `Failed to reach ${dto.url}: ${(e as Error).message}`,
        502,
      );
    }
    if (!response.ok) {
      throw new CanaryError("request-failed", `HTTP ${response.status} from ${dto.url}`, 502);
    }
    const payload = await response.text();
    return { payload };
  }
}
