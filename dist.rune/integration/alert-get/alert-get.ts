import type { MonitorIdDto } from "../../dto/monitor-id-dto.ts";
import type { AlertDto } from "../../dto/alert-dto.ts";
import { Alert } from "../../impure/alert/alert.ts";
import { log } from "../../impure/_log.ts";

export async function getAlert(input: MonitorIdDto): Promise<AlertDto> {
  log.debug("🚀 alert.get", input.monitorId);
  const alert = new Alert();
  const result = await alert.get(input.monitorId);
  log.debug("✅ alert.get", result.monitorId, result.recipients.length, "recipients");
  return result;
}
