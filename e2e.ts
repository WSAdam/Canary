/**
 * End-to-end alert send test.
 * Sends a real email and a real SMS using the configured Postmark and Zapier credentials.
 *
 * Usage:
 *   deno run --allow-net --allow-env --env-file e2e.ts
 */

import { Email } from "./dist.rune/impure/alertChannel/implementations/email/mod.ts";
import { Sms } from "./dist.rune/impure/alertChannel/implementations/sms/mod.ts";
import type { RunResultDto } from "./dist.rune/dto/run-result-dto.ts";
import type { AlertDto } from "./dist.rune/dto/alert-dto.ts";

const fakeRun: RunResultDto = {
  runId: "e2e-" + Date.now(),
  monitorId: "test-monitor",
  monitorName: "E2E Test Monitor",
  observed: 42,
  passed: false,
  timestamp: new Date().toISOString(),
};

const fakeAlert: AlertDto = {
  monitorId: "test-monitor",
  recipients: [],
};

// ── Email ──────────────────────────────────────────────────────────────────────
const emailTarget = "adamp@monsterrg.com";
console.log(`\n📧 Sending test email to ${emailTarget}...`);
const emailChannel = new Email(emailTarget);
await emailChannel.send(fakeRun, fakeAlert);
console.log(`✅ Email sent to ${emailTarget}`);

// ── SMS ────────────────────────────────────────────────────────────────────────
const smsTarget = "+18432222986";
console.log(`\n📱 Sending test SMS to ${smsTarget}...`);
const smsChannel = new Sms(smsTarget);
await smsChannel.send(fakeRun, fakeAlert);
console.log(`✅ SMS sent to ${smsTarget}`);

console.log("\n✅ E2E complete — check adamp@monsterrg.com and +18432222986");
