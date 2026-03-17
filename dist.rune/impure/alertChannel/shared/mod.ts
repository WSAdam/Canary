import type { RunResultDto } from "../../../dto/run-result-dto.ts";
import type { AlertDto } from "../../../dto/alert-dto.ts";

export abstract class BaseAlertChannel {
  abstract send(run: RunResultDto, alert: AlertDto): Promise<void>;
}
