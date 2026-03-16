import type { CheckDto } from "../../../dto/check-dto.ts";
import type { ResponseDto } from "../../../dto/response-dto.ts";

export abstract class BaseSource {
  abstract fetch(dto: CheckDto): Promise<ResponseDto>;
}
