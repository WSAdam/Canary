import type { CheckDto } from "../../../dto/check-dto.ts";
import type { ResponseDto } from "../../../dto/response-dto.ts";

export abstract class BaseSource {
  // secretValues: resolved secret strings to scrub from any logs/error text.
  abstract fetch(dto: CheckDto, secretValues?: string[]): Promise<ResponseDto>;
}
