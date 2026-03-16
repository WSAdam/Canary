import type { RunResultDto } from "../../../dto/run-result-dto.ts";

export abstract class BaseAlertChannel {
  abstract send(dto: RunResultDto): Promise<void>;
}
