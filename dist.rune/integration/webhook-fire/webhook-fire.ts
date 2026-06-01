import { Monitor } from "../../impure/monitor/monitor.ts";
import { Check } from "../../impure/check/check.ts";
import { WebhookSecret } from "../../impure/webhookSecret/webhookSecret.ts";
import { persistRunAndAlert, type PersistAndAlertResult } from "../_shared/persistRunAndAlert.ts";
import type { FireAlertDto } from "../../dto/fire-alert-dto.ts";

export interface WebhookFireInput {
  monitorId: string;
  plaintextSecret: string;
  payload: FireAlertDto;
}

export async function webhookFire(input: WebhookFireInput): Promise<PersistAndAlertResult> {
  console.log(`🪝 webhook.fire: starting for monitorId=${input.monitorId}`);

  // Auth check — throws CanaryError(unauthorized, 401) on mismatch or missing key
  await WebhookSecret.verify(input.monitorId, input.plaintextSecret);

  // Load monitor — throws CanaryError(not-found, 404) if unknown
  const monitor = new Monitor();
  const monitorDto = await monitor.get(input.monitorId);
  console.log(`✅ webhook.fire: monitor name="${monitorDto.name}"`);

  // notifyOnRecover comes from the check if there is one, otherwise default true
  let notifyOnRecover = true;
  try {
    const check = new Check();
    const checkDto = await check.get(input.monitorId);
    notifyOnRecover = checkDto.notifyOnRecover;
  } catch {
    console.log(`🔍 webhook.fire: no check configured — defaulting notifyOnRecover=true`);
  }

  const { passed, observed, error, captures, message, title } = input.payload;

  return await persistRunAndAlert({
    monitorId: input.monitorId,
    monitorName: monitorDto.name,
    observed: typeof observed === "number" ? observed : 0,
    passed: passed === true,                          // default false
    error,
    captures,
    notifyOnRecover,
    suppressAlertOnError: false,                      // caller is asking us to alert; error is content not a reason to skip
    source: "webhook",
    alertOverrides: (message || title) ? { message, title } : undefined,
  });
}
