import type { ConfigureAlertDto } from "../../dto/configure-alert-dto.ts";
import type { AlertDto } from "../../dto/alert-dto.ts";
import { Alert } from "../../impure/alert/alert.ts";
import { normalizeNtfyUrl } from "../../impure/alertChannel/implementations/ntfy/mod.ts";
import { CanaryError } from "../../dto/_shared.ts";

export async function configureAlert(input: ConfigureAlertDto): Promise<AlertDto> {
  console.log("🚀 alert.configure", input.monitorId, input.recipients.length, "recipients");
  // Reject an unusable ntfy topic at save time so the alert can't be stored in a
  // state that silently fails to deliver. Reuses the send-time normalizer.
  for (const r of input.recipients) {
    if (r.channel !== "ntfy") continue;
    try {
      normalizeNtfyUrl(r.address);
    } catch {
      throw new CanaryError("validation-error", `ntfy topic "${r.address}" is invalid — use a topic name or full ntfy URL`, 400);
    }
  }
  const alert = Alert.build(input);
  const alertDto = alert.toDto();
  const result = await alert.upsert(alertDto);
  console.log("✅ alert.configure", result.monitorId);
  return result;
}
