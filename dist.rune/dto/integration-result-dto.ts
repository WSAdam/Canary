import type { RunResultDto } from "./run-result-dto.ts";

/** result of provisioning an integration: the created monitor, the secret key
 *  the project's token was stored under, and the first verification run so the
 *  caller can immediately see whether the wiring works (firstRun.error set =
 *  unreachable / bad secret / shape mismatch). */
export interface IntegrationResultDto {
  monitorId: string;
  secretKey: string;
  firstRun: RunResultDto;
}
