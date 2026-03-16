import type { CheckDto } from "../../dto/check-dto.ts";
import type { ResponseDto } from "../../dto/response-dto.ts";
import { CanaryError } from "../../dto/_shared.ts";

export class Extractor {
  static apply(dto: CheckDto, responseDto: ResponseDto): number {
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseDto.payload);
    } catch {
      throw new CanaryError("extraction-failed", "Response payload is not valid JSON", 422);
    }

    const value = dto.expression.split(".").reduce((obj: unknown, key: string) => {
      if (obj === null || obj === undefined || typeof obj !== "object") return undefined;
      return (obj as Record<string, unknown>)[key];
    }, parsed);

    if (typeof value !== "number") {
      throw new CanaryError(
        "extraction-failed",
        `Expression "${dto.expression}" resolved to ${value === undefined ? "undefined" : typeof value}, expected number`,
        422,
      );
    }
    return value;
  }
}
