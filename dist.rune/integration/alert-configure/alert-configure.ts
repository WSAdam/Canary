import type { ConfigureAlertDto } from "../../dto/configure-alert-dto.ts";
import type { AlertDto } from "../../dto/alert-dto.ts";
import { Monitor } from "../../impure/monitor/monitor.ts";
import { Alert } from "../../impure/alert/alert.ts";

export async function configureAlert(input: ConfigureAlertDto): Promise<AlertDto> {
  console.log("🚀 alert.configure", input.monitorId, input.recipients.length, "recipients");
  const monitor = new Monitor();
  await monitor.get(input.monitorId); // throws not-found if monitor doesn't exist
  const alert = Alert.build(input);
  const alertDto = alert.toDto();
  const result = await alert.upsert(alertDto);
  console.log("✅ alert.configure", result.monitorId);
  return result;
}
