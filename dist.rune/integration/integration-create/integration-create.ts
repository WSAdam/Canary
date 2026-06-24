import type { CreateIntegrationDto } from "../../dto/create-integration-dto.ts";
import type { IntegrationResultDto } from "../../dto/integration-result-dto.ts";
import type { RunResultDto } from "../../dto/run-result-dto.ts";
import { createMonitor } from "../monitor-create/monitor-create.ts";
import { configureCheck } from "../check-configure/check-configure.ts";
import { configureAlert } from "../alert-configure/alert-configure.ts";
import { executeRunner } from "../runner-execute/runner-execute.ts";
import { Secret } from "../../impure/secret/secret.ts";
import { kv } from "../../impure/_kv.ts";
import { CanaryError } from "../../dto/_shared.ts";
import { log } from "../../impure/_log.ts";

// The Canary health contract: every integrated project exposes this path,
// auth'd by a bearer secret, returning { totalErrors, ... } for an ET day.
const HEALTH_PATH = "/canary/errors";
// Default schedule: once daily at 13:00 UTC (~09:00 ET) so the run lands well
// after ET midnight and reports the full previous ET day.
const DEFAULT_CRON = "0 13 * * *";

/** Derive a {{KEY}}-referenceable secret key from the integration name. */
export function secretKeyForIntegration(name: string): string {
  const slug = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!slug) {
    throw new CanaryError("validation-error", "Integration name must contain letters or numbers", 400);
  }
  return `${slug}_CANARY_SECRET`;
}

/** Provision a standard health-check integration end-to-end: monitor + secret +
 *  check + alert, then fire one verification run. Best-effort rollback on
 *  partial failure since Deno KV has no multi-key transactions. */
export async function createIntegration(input: CreateIntegrationDto): Promise<IntegrationResultDto> {
  const name = (input.name ?? "").trim();
  const baseUrl = (input.baseUrl ?? "").trim();
  const secret = (input.secret ?? "").trim();
  log.info(`🔌 integration.create: name="${name}" baseUrl=${baseUrl}`);

  if (!name) throw new CanaryError("validation-error", "name is required", 400);
  if (!baseUrl) throw new CanaryError("validation-error", "baseUrl is required", 400);
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new CanaryError("validation-error", "baseUrl must start with http:// or https://", 400);
  }
  if (!secret) throw new CanaryError("validation-error", "secret is required", 400);
  // Bound the token so it can't blow past Deno KV's ~64 KiB per-value limit as an
  // opaque 500 (mirrors setSecret's MAX_SECRET_VALUE_LENGTH). Measure serialized
  // BYTES, not .length — a sub-limit count of multi-byte chars could still exceed
  // the byte cap and surface as a 500.
  if (new TextEncoder().encode(secret).length > 60 * 1024) {
    throw new CanaryError("validation-error", "secret must be at most 61440 bytes", 400);
  }
  if (!input.recipients?.length) {
    throw new CanaryError("validation-error", "at least one recipient is required", 400);
  }

  const secretKey = secretKeyForIntegration(name);
  const url = baseUrl.replace(/\/+$/, "") + HEALTH_PATH;
  const cron = (input.cron ?? "").trim() || DEFAULT_CRON;

  // The secret key is derived by slugifying the name, so distinct monitor names
  // ("Acme App" vs "Acme-App") can collapse to the SAME key. Monitor uniqueness
  // wouldn't catch that, so setSecret would blindly overwrite an existing
  // integration's token — and a later rollback would delete a key another live
  // integration still depends on. Refuse up front when the derived key is taken.
  //
  // Read with strong consistency — a default eventually-consistent read can
  // return a stale null for a secret a concurrent/just-finished create already
  // wrote, defeating the guard. The atomic claim below is the real protection;
  // this read just lets us surface a clean 409 in the common case.
  const existingSecret = await kv.get(["secret", secretKey], { consistency: "strong" });
  if (existingSecret.value !== null) {
    throw new CanaryError(
      "duplicate-name",
      `Integration name "${name}" derives secret key "${secretKey}" which is already in use by another integration`,
      409,
    );
  }

  // 1. Monitor (enforces name uniqueness via an atomic KV check).
  const monitor = await createMonitor({
    name,
    description: (input.description ?? "").trim() || `Health monitor for ${name}`,
  });

  // Track whether THIS invocation actually wrote the secret, so rollback only
  // deletes a key we created — never one owned by a pre-existing integration.
  let secretCreated = false;
  try {
    // 2. Store the project's token; the check references it as {{KEY}}.
    //    Claim the key atomically (check versionstamp:null) so a concurrent
    //    create whose name slugs to the same key can't both pass the read above
    //    and clobber each other — the loser gets a 409 instead of overwriting a
    //    live integration's token that a later rollback could then delete.
    const claim = await kv.atomic()
      .check({ key: ["secret", secretKey], versionstamp: null })
      .set(["secret", secretKey], secret)
      .commit();
    if (!claim.ok) {
      throw new CanaryError(
        "duplicate-name",
        `Integration name "${name}" derives secret key "${secretKey}" which is already in use by another integration`,
        409,
      );
    }
    secretCreated = true;

    // 3. Check — the standard health-contract boilerplate. healthy = totalErrors <= 0.
    await configureCheck({
      monitorId: monitor.monitorId,
      url,
      method: "POST",
      headers: { Authorization: `Bearer {{${secretKey}}}` },
      expression: "totalErrors",
      comparatorOp: "lte",
      threshold: 0,
      cron,
      notifyOnRecover: true,
    });

    // 4. Alert recipients.
    await configureAlert({ monitorId: monitor.monitorId, recipients: input.recipients });
  } catch (err) {
    log.warn(`⚠️ integration.create: provisioning failed for "${name}" — rolling back: ${(err as Error).message}`);
    await rollback(monitor.monitorId, name, secretCreated ? secretKey : null);
    throw err;
  }

  // 5. Verify-on-setup: fire one real run so the caller sees green/red now.
  //    executeRunner persists the error rather than throwing on a failed check,
  //    so firstRun.error (if set) is the actionable wiring signal. suppressAlert
  //    so a not-yet-wired endpoint doesn't page every recipient during setup.
  let firstRun: RunResultDto;
  try {
    firstRun = await executeRunner({ monitorId: monitor.monitorId }, { suppressAlert: true });
  } catch (err) {
    log.warn(`⚠️ integration.create: verification run threw for "${name}": ${(err as Error).message}`);
    firstRun = {
      runId: `verify-${monitor.monitorId}`,
      monitorId: monitor.monitorId,
      monitorName: name,
      observed: 0,
      passed: false,
      timestamp: new Date().toISOString(),
      error: (err as Error).message,
    };
  }

  log.info(`✅ integration.create: "${name}" monitorId=${monitor.monitorId} firstRun.passed=${firstRun.passed} error=${firstRun.error ?? "none"}`);
  return { monitorId: monitor.monitorId, secretKey, firstRun };
}

/** Remove every key a partial provisioning may have written. Each delete is
 *  best-effort — a failure here must not mask the original provisioning error. */
async function rollback(monitorId: string, name: string, secretKey: string | null): Promise<void> {
  const ops = [
    () => kv.delete(["monitor", monitorId]),
    () => kv.delete(["monitor_name", name]),
    () => kv.delete(["check", monitorId]),
    () => kv.delete(["alert", monitorId]),
  ];
  // Only delete the secret if THIS invocation created it — never a key that was
  // already owned by another live integration (collision case).
  if (secretKey !== null) ops.push(() => new Secret().delete(secretKey));
  for (const op of ops) {
    try {
      await op();
    } catch (e) {
      log.warn(`⚠️ integration.create: rollback step failed (ignored): ${(e as Error).message}`);
    }
  }
}
