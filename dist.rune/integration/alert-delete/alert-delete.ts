import type { MonitorIdDto } from "../../dto/monitor-id-dto.ts";
import type { AlertDto } from "../../dto/alert-dto.ts";
import { Alert } from "../../impure/alert/alert.ts";
import { log } from "../../impure/_log.ts";

export async function deleteAlert(input: MonitorIdDto): Promise<AlertDto> {
  log.debug("🚀 alert.delete", input.monitorId);
  const alert = new Alert();
  const existing = await alert.get(input.monitorId); // throws not-found if missing
  await alert.delete(input.monitorId);
  log.info("✅ alert.delete", existing.monitorId);
  return existing;
}
