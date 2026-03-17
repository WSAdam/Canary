import type { ConfigureAlertDto } from "../../dto/configure-alert-dto.ts";
import type { AlertDto } from "../../dto/alert-dto.ts";
import { Alert } from "../../impure/alert/alert.ts";

export async function configureAlert(input: ConfigureAlertDto): Promise<AlertDto> {
  console.log("🚀 alert.configure", input.monitorId, input.recipients.length, "recipients");
  const alert = Alert.build(input);
  const alertDto = alert.toDto();
  const result = await alert.upsert(alertDto);
  console.log("✅ alert.configure", result.monitorId);
  return result;
}
