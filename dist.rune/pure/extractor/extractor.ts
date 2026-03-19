import type { CheckDto } from "../../dto/check-dto.ts";
import type { ResponseDto } from "../../dto/response-dto.ts";
import { CanaryError } from "../../dto/_shared.ts";

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce((o: unknown, key: string) => {
    if (o === null || o === undefined || typeof o !== "object") return undefined;
    return (o as Record<string, unknown>)[key];
  }, obj);
}

export class Extractor {
  static apply(dto: CheckDto, responseDto: ResponseDto): number {
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseDto.payload);
    } catch {
      throw new CanaryError("extraction-failed", "Response payload is not valid JSON", 422);
    }

    const value = getPath(parsed, dto.expression);

    if (typeof value !== "number") {
      throw new CanaryError(
        "extraction-failed",
        `Expression "${dto.expression}" resolved to ${value === undefined ? "undefined" : typeof value}, expected number`,
        422,
      );
    }
    return value;
  }

  static applyCaptures(captures: Record<string, string>, payload: string): Record<string, string> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [name, path] of Object.entries(captures)) {
      const val = getPath(parsed, path);
      result[name] = val === undefined ? "" : String(val);
    }
    return result;
  }
}
