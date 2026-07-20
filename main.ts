import { assertFetchableUrl, CanaryError, fetchNoSsrfRedirect, requireString } from "./dist.rune/dto/_shared.ts";
import { kv } from "./dist.rune/impure/_kv.ts";
import type { CheckDto } from "./dist.rune/dto/check-dto.ts";
import {
  createUser,
  deleteUser,
  listUsers,
  login,
  logout,
  seedAdmin,
  validateSession,
} from "./dist.rune/impure/auth/auth.ts";
import { createInvites, markInviteConsumed, peekInvite } from "./dist.rune/impure/invite/invite.ts";

// Integration imports
import { createMonitor } from "./dist.rune/integration/monitor-create/monitor-create.ts";
import { listMonitors } from "./dist.rune/integration/monitor-list/monitor-list.ts";
import { getMonitor } from "./dist.rune/integration/monitor-get/monitor-get.ts";
import { updateMonitor } from "./dist.rune/integration/monitor-update/monitor-update.ts";
import { deleteMonitor } from "./dist.rune/integration/monitor-delete/monitor-delete.ts";
import { configureCheck } from "./dist.rune/integration/check-configure/check-configure.ts";
import { getCheck } from "./dist.rune/integration/check-get/check-get.ts";
import { buildSchedule } from "./dist.rune/integration/schedule-build/schedule-build.ts";
import { configureAlert } from "./dist.rune/integration/alert-configure/alert-configure.ts";
import { getAlert } from "./dist.rune/integration/alert-get/alert-get.ts";
import { deleteAlert } from "./dist.rune/integration/alert-delete/alert-delete.ts";
import { setSecret } from "./dist.rune/integration/secret-set/secret-set.ts";
import { listSecrets } from "./dist.rune/integration/secret-list/secret-list.ts";
import { deleteSecret } from "./dist.rune/integration/secret-delete/secret-delete.ts";
import { executeRunner } from "./dist.rune/integration/runner-execute/runner-execute.ts";
import { createIntegration } from "./dist.rune/integration/integration-create/integration-create.ts";
import { webhookFire } from "./dist.rune/integration/webhook-fire/webhook-fire.ts";
import { createRelayMonitor } from "./dist.rune/integration/relay-create/relay-create.ts";
import { configureRelay } from "./dist.rune/integration/relay-configure/relay-configure.ts";
import { deleteRelay } from "./dist.rune/integration/relay-delete/relay-delete.ts";
import { fireRelay } from "./dist.rune/integration/relay-fire/relay-fire.ts";
import { Relay } from "./dist.rune/impure/relay/relay.ts";
import type { CreateRelayDto } from "./dist.rune/dto/create-relay-dto.ts";
import type { ConfigureRelayDto } from "./dist.rune/dto/configure-relay-dto.ts";
import type { RelayFireDto } from "./dist.rune/dto/relay-fire-dto.ts";
import { WebhookSecret } from "./dist.rune/impure/webhookSecret/webhookSecret.ts";
import type { FireAlertDto } from "./dist.rune/dto/fire-alert-dto.ts";
import { Email } from "./dist.rune/impure/alertChannel/implementations/email/mod.ts";
import { Sms } from "./dist.rune/impure/alertChannel/implementations/sms/mod.ts";
import { Ntfy } from "./dist.rune/impure/alertChannel/implementations/ntfy/mod.ts";
import { RunResult } from "./dist.rune/impure/runResult/runResult.ts";
import type { RunResultDto } from "./dist.rune/dto/run-result-dto.ts";
import type { AlertDto } from "./dist.rune/dto/alert-dto.ts";
import { log } from "./dist.rune/impure/_log.ts";
import { redactHeaders } from "./dist.rune/integration/runner-execute/runner-execute.ts";
import { getDenoUsage } from "./dist.rune/integration/deno-usage/deno-usage.ts";
import { getDenoSpend } from "./dist.rune/integration/deno-spend/deno-spend.ts";
import { isInternalUrl, runInternal } from "./dist.rune/impure/source/implementations/internal/mod.ts";

// ---------------------------------------------------------------------------
// Seed admin on startup
// ---------------------------------------------------------------------------

const adminUsername = Deno.env.get("ADMIN_USERNAME");
const adminPassword = Deno.env.get("ADMIN_PASSWORD");
if (adminUsername && adminPassword) {
  await seedAdmin(adminUsername, adminPassword);
} else {
  log.warn("⚠️ ADMIN_USERNAME or ADMIN_PASSWORD not set — admin not seeded");
}

// ---------------------------------------------------------------------------
// Cron: check all monitors every minute
// ---------------------------------------------------------------------------

function matchField(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field.includes(",")) return field.split(",").some((f) => matchField(f.trim(), value));
  if (field.includes("/")) {
    const [range, step] = field.split("/");
    const s = parseInt(step);
    if (!(s > 0)) return false; // guard against */0 (rejected at config time, defensive here)
    if (range === "*") return value % s === 0;
    const [start, endRaw] = range.split("-").map(Number);
    // A single-number-with-step field like "5/15" means "every s starting at
    // start" with NO upper bound — range.split("-") yields only [start], so
    // endRaw is NaN. Treat a missing end as +Infinity so the open-ended form
    // fires (5,20,35,…) instead of never matching (value <= NaN is always false).
    const end = Number.isNaN(endRaw) ? Infinity : endRaw;
    return value >= start && value <= end && (value - start) % s === 0;
  }
  if (field.includes("-")) {
    const [start, end] = field.split("-").map(Number);
    return value >= start && value <= end;
  }
  return parseInt(field) === value;
}

function cronMatchesNow(cron: string, now: Date): boolean {
  // Defensive: a check row with a missing/non-string cron, or one with fewer
  // than 5 fields (weekday undefined → matchField throws), must not throw a raw
  // TypeError that aborts the whole cron tick. Treat malformed crons as "not due".
  if (typeof cron !== "string") return false;
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [min, hour, day, month, weekday] = parts;
  // Use UTC throughout so schedule matching agrees with the UTC dedup key and
  // Deno Deploy's UTC clock. getUTCDay() is 0 (Sun)–6 (Sat); also treat 7 as
  // Sunday so the common "7 = Sunday" cron convention fires.
  const dow = now.getUTCDay();
  const weekdayMatches = matchField(weekday, dow) || (dow === 0 && matchField(weekday, 7));
  return (
    matchField(min, now.getUTCMinutes()) &&
    matchField(hour, now.getUTCHours()) &&
    matchField(day, now.getUTCDate()) &&
    matchField(month, now.getUTCMonth() + 1) &&
    weekdayMatches
  );
}

const startedAt = new Date().toISOString();
let lastCronTick: string | null = null;
let lastTickMinuteKey: string | null = null;

const FIVE_MIN_MS = 5 * 60 * 1000;

Deno.cron("canary-runner", "* * * * *", async () => {
  const now = new Date();
  const minuteKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}-${now.getUTCMinutes()}`;

  // In-process guard: same isolate firing twice in one minute (rare but possible if cron rescheduled mid-run)
  if (lastTickMinuteKey === minuteKey) {
    log.debug("🔍 cron tick: skipped (this isolate already ran this minute)");
    return;
  }
  lastTickMinuteKey = minuteKey;

  // Cross-isolate KV lock with auto-expiry so old keys clean themselves
  const tickKey = ["cron-tick", minuteKey];
  const lock = await kv.atomic()
    .check({ key: tickKey, versionstamp: null })
    .set(tickKey, 1, { expireIn: FIVE_MIN_MS })
    .commit();
  if (!lock.ok) {
    log.debug("🔍 cron tick: skipped (another isolate already running this minute)");
    return;
  }
  lastCronTick = now.toISOString();
  log.debug("🔍 cron tick:", now.toISOString());

  const due: string[] = [];
  // Iterate one row at a time with a per-row error boundary so a single corrupt
  // check row (undeserializable value, or a malformed cron that slips past
  // cronMatchesNow's guards) can't reject the whole tick and silently halt ALL
  // monitoring every minute. batchSize:1 isolates the failure to its row; an
  // undeserializable value throws when the iterator advances onto it, so we log
  // and stop the scan (KV can't advance its cursor past such a row) — the
  // monitors already collected still run.
  const iter = kv.list<CheckDto>({ prefix: ["check"] }, { batchSize: 1 });
  while (true) {
    let entry: IteratorResult<Deno.KvEntry<CheckDto>>;
    try {
      entry = await iter.next();
    } catch (e) {
      log.error(`❌ cron tick: check scan hit an unreadable row — stopping scan: ${(e as Error).message}`);
      break;
    }
    if (entry.done) break;
    const checkDto = entry.value.value;
    try {
      if (!cronMatchesNow(checkDto.cron, now)) continue;

      // Per-monitor-per-minute lock: belt-and-suspenders against regional KV non-linearizability
      const runLockKey = ["run-lock", checkDto.monitorId, minuteKey];
      const runLock = await kv.atomic()
        .check({ key: runLockKey, versionstamp: null })
        .set(runLockKey, 1, { expireIn: FIVE_MIN_MS })
        .commit();
      if (!runLock.ok) {
        log.debug(`🔍 run skipped for ${checkDto.monitorId} (another isolate already ran this minute)`);
        continue;
      }
      due.push(checkDto.monitorId);
    } catch (e) {
      // A bad single row (e.g. unexpected shape reaching the lock logic) must not
      // abort scheduling for every other monitor.
      log.error(`❌ cron tick: skipping a check row due to error: ${(e as Error).message}`);
    }
  }

  // Run due monitors in bounded batches so a busy minute can't fan out into an
  // unbounded burst of simultaneous outbound fetches.
  // Idle ticks (nothing due) are the dominant log noise — keep them at debug so
  // the default info level only surfaces minutes that actually do work.
  if (due.length > 0) log.info(`⏰ cron tick: ${due.length} monitor(s) due`);
  else log.debug(`⏰ cron tick: 0 monitor(s) due`);
  const CONCURRENCY = 10;
  for (let i = 0; i < due.length; i += CONCURRENCY) {
    const batch = due.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((monitorId) => {
      log.info("⏰ scheduling run for monitor:", monitorId);
      return executeRunner({ monitorId }).catch((e) => {
        log.error("❌ runner failed for", monitorId, ":", (e as Error).message);
      });
    }));
  }
});

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <ellipse cx="42" cy="64" rx="26" ry="20" fill="#FFD700"/>
  <circle cx="66" cy="38" r="19" fill="#FFD700"/>
  <polygon points="83,36 97,32 83,43" fill="#FF8C00"/>
  <circle cx="72" cy="32" r="4.5" fill="#1a1a1a"/>
  <circle cx="73" cy="31" r="1.8" fill="white"/>
  <ellipse cx="37" cy="65" rx="17" ry="9" fill="#FFC107" transform="rotate(-15 37 65)"/>
  <polygon points="17,70 4,58 4,80" fill="#FFB300"/>
  <line x1="46" y1="84" x2="38" y2="96" stroke="#FF8C00" stroke-width="3.5" stroke-linecap="round"/>
  <line x1="38" y1="96" x2="32" y2="99" stroke="#FF8C00" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="38" y1="96" x2="43" y2="100" stroke="#FF8C00" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="56" y1="84" x2="64" y2="96" stroke="#FF8C00" stroke-width="3.5" stroke-linecap="round"/>
  <line x1="64" y1="96" x2="70" y2="99" stroke="#FF8C00" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="64" y1="96" x2="60" y2="100" stroke="#FF8C00" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Canary</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --y:#FFD700;--bg:#0f0f0f;--s:#1a1a1a;--b:#2a2a2a;--t:#e0e0e0;--m:#777;--red:#ff5f5f;--green:#4ade80;
}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--t);min-height:100vh}
.center{display:flex;align-items:center;justify-content:center;min-height:100vh}
.page{width:100%;max-width:520px;padding:24px}
.wide{width:100%;max-width:860px;padding:24px;margin:0 auto}

/* Typography */
h2{font-size:18px;font-weight:600;margin-bottom:20px}
label{display:block;font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.5px;color:var(--m);margin-bottom:7px}

/* Inputs */
input,select,textarea{width:100%;padding:10px 14px;background:var(--bg);border:1px solid var(--b);border-radius:8px;color:var(--t);font-size:14px;outline:none;transition:border-color .15s;font-family:inherit}
input:focus,select:focus,textarea:focus{border-color:var(--y)}
select option{background:var(--s)}
textarea{resize:vertical;min-height:72px}
.form-group{margin-bottom:16px}
.form-row{display:grid;gap:12px;margin-bottom:16px}
.col2{grid-template-columns:1fr 1fr}
.col3{grid-template-columns:1fr 1fr 1fr}

/* Buttons */
.btn{padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;border:none;transition:opacity .15s}
.btn:hover{opacity:.85}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-primary{background:var(--y);color:#000}
.btn-ghost{background:none;border:1px solid var(--b);color:var(--m)}
.btn-ghost:hover{border-color:var(--t);color:var(--t);opacity:1}
.btn-danger{background:none;border:1px solid #3a1a1a;color:var(--red)}
.btn-danger:hover{border-color:var(--red);opacity:1}
.btn-full{width:100%}
.btn-sm{padding:6px 14px;font-size:12px}
.var-chips{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:6px}
.var-chips-label{font-size:11px;color:#666;margin-right:2px}
.var-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:4px;font-size:11px;font-family:ui-monospace,Menlo,Monaco,monospace;color:#FFD700;cursor:pointer;transition:.1s}
.var-chip:hover{background:#222;border-color:#FFD700}
.var-chip-example{color:#666;font-style:italic;font-family:inherit}

/* Cards */
.card{background:var(--s);border:1px solid var(--b);border-radius:10px;padding:20px}
.card+.card{margin-top:12px}

/* Auth views */
.auth-card{background:var(--s);border:1px solid var(--b);border-radius:14px;padding:44px 40px}
.logo{text-align:center;margin-bottom:36px}
.logo img{width:56px;height:56px}
.logo h1{font-size:22px;font-weight:600;margin-top:14px}
.logo p{color:var(--m);font-size:13px;margin-top:5px}
.error-msg{color:var(--red);font-size:13px;margin-top:12px;text-align:center;min-height:18px}
.success-msg{color:var(--green);font-size:13px;margin-top:12px;text-align:center;min-height:18px}

/* Dashboard */
.dash-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;padding-top:24px}
.dash-title{display:flex;align-items:center;gap:10px}
.dash-title img{width:28px;height:28px}
.dash-title h1{font-size:18px;font-weight:600}
.dash-actions{display:flex;gap:8px;align-items:center}
.status-row{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:28px}
.stat-card{background:var(--s);border:1px solid var(--b);border-radius:10px;padding:18px 20px}
.stat-label{font-size:11px;color:var(--m);text-transform:uppercase;letter-spacing:.5px}
.stat-val{font-size:26px;font-weight:700;margin-top:6px}
.stat-val.ok{color:var(--y)}
.stat-sub{font-size:12px;color:var(--m);margin-top:4px}
.section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.section-title{font-size:15px;font-weight:600}

/* Monitor cards */
.monitor-card{background:var(--s);border:1px solid var(--b);border-radius:10px;padding:18px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.monitor-card+.monitor-card{margin-top:10px}
.monitor-info h3{font-size:15px;font-weight:600;margin-bottom:3px}
.monitor-info p{font-size:13px;color:var(--m)}
.monitor-actions{display:flex;gap:8px;flex-shrink:0}
.empty-state{text-align:center;padding:48px 0;color:var(--m);font-size:14px}
.empty-state p{margin-top:8px;font-size:13px}

/* Wizard */
.wizard-header{display:flex;align-items:center;gap:16px;margin-bottom:28px;padding-top:24px}
.wizard-back{background:none;border:none;color:var(--m);cursor:pointer;font-size:20px;padding:4px;line-height:1}
.wizard-back:hover{color:var(--t)}
.steps{display:flex;align-items:center;gap:0;margin-bottom:32px}
.step{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--m)}
.step-num{width:26px;height:26px;border-radius:50%;border:1px solid var(--b);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex-shrink:0}
.step.active .step-num{background:var(--y);border-color:var(--y);color:#000}
.step.done .step-num{background:#2a2a2a;border-color:#2a2a2a;color:var(--y)}
.step.active{color:var(--t)}
.step-line{flex:1;height:1px;background:var(--b);margin:0 8px}
.wizard-footer{display:flex;gap:10px;margin-top:24px;justify-content:flex-end}

/* Headers builder */
.headers-list{margin-bottom:8px}
.header-row{display:grid;grid-template-columns:1fr 1fr 32px;gap:8px;margin-bottom:8px;align-items:center}
.header-row input{margin:0}
.icon-btn{width:32px;height:32px;border-radius:6px;border:1px solid var(--b);background:none;color:var(--m);cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center}
.icon-btn:hover{border-color:var(--red);color:var(--red)}

/* Recipients */
.recipient-row{display:grid;grid-template-columns:120px 1fr 32px;gap:8px;margin-bottom:8px;align-items:center}
.recipient-row select,.recipient-row input{margin:0}

/* SMS numbers */
.sms-row{display:grid;grid-template-columns:1fr 32px;gap:8px;margin-bottom:8px;align-items:center}
.sms-row input{margin:0}

/* Corrupt-run banner (Reports tab) */
.corrupt-banner{margin-top:10px;padding:10px 12px;border:1px solid #4a3a1a;background:#1a160d;border-radius:8px;font-size:12px;color:#e0c98a;display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.corrupt-banner-legacy{flex-direction:column;align-items:stretch}
.corrupt-banner code{font-family:ui-monospace,Menlo,monospace;background:#0d0b06;padding:1px 4px;border-radius:3px}
.corrupt-purge-form{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.corrupt-dismiss{font-size:11px;color:#9a8a5a}
.corrupt-purge-form input{flex:1;min-width:160px;background:#111;border:1px solid #2a2a2a;border-radius:6px;padding:6px 10px;color:#e0e0e0;font-size:12px}

/* Toggle */
.toggle-row{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-top:1px solid var(--b)}
.toggle-label{font-size:14px}
.toggle-desc{font-size:12px;color:var(--m);margin-top:2px}
input[type=checkbox]{width:auto;accent-color:var(--y)}

/* Schedule */
.schedule-tabs{display:flex;gap:0;margin-bottom:16px;border:1px solid var(--b);border-radius:8px;overflow:hidden}
.sched-tab{flex:1;padding:8px;font-size:13px;font-weight:500;cursor:pointer;background:none;border:none;color:var(--m);transition:background .15s}
.sched-tab.active{background:var(--s);color:var(--t)}
.sched-tab:hover:not(.active){background:#1a1a1a}

/* Invite modal */
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:100;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:var(--s);border:1px solid var(--b);border-radius:14px;padding:36px;width:100%;max-width:500px;max-height:90vh;overflow-y:auto}
.modal-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
.modal-header h2{font-size:18px;font-weight:600;margin:0}
.modal-close{background:none;border:none;color:var(--m);cursor:pointer;font-size:22px;line-height:1;padding:2px}
.modal-close:hover{color:var(--t)}
.report-row-clickable{cursor:pointer}
.report-row-clickable:hover{background:#161616}
.invite-email-row{display:grid;grid-template-columns:1fr 32px;gap:8px;margin-bottom:8px;align-items:center}
.invite-email-row input{margin:0}

/* Section divider */
.divider{border:none;border-top:1px solid var(--b);margin:20px 0}
.hint{font-size:12px;color:var(--m);margin-top:6px;line-height:1.5}

/* Spinner */
@keyframes spin{to{transform:rotate(360deg)}}
.spinner{width:16px;height:16px;border:2px solid var(--b);border-top-color:var(--y);border-radius:50%;animation:spin .6s linear infinite;display:inline-block;vertical-align:middle;margin-right:6px}
</style>
</head>
<body>

<!-- ============================================================ LOGIN ============================================================ -->
<div id="view-login" class="center">
<div class="page">
<div class="auth-card">
  <div class="logo">
    <img src="/favicon.svg" alt="Canary">
    <h1>Canary</h1>
    <p>HTTP monitoring and alerting</p>
  </div>
  <div class="form-group">
    <label for="li-user">Username</label>
    <input type="text" id="li-user" placeholder="you@example.com" autocomplete="username">
  </div>
  <div class="form-group">
    <label for="li-pass">Password</label>
    <input type="password" id="li-pass" placeholder="••••••••" autocomplete="current-password">
  </div>
  <button class="btn btn-primary btn-full" id="li-btn" onclick="doLogin()">Sign in</button>
  <div class="error-msg" id="li-err"></div>
</div>
</div>
</div>

<!-- ============================================================ INVITE ACCEPT ============================================================ -->
<div id="view-invite-accept" class="center" style="display:none">
<div class="page">
<div class="auth-card">
  <div class="logo">
    <img src="/favicon.svg" alt="Canary">
    <h1>Welcome to Canary</h1>
    <p>You've been invited. Set a password to activate your account.</p>
  </div>
  <div style="background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:14px 16px;margin-bottom:20px;text-align:center">
    <p style="font-size:11px;color:#555;letter-spacing:.08em;margin:0 0 4px">SIGNING IN AS</p>
    <p id="ia-email-display" style="font-size:15px;color:#FFD700;font-weight:600;margin:0">Loading...</p>
  </div>
  <input type="hidden" id="ia-email">
  <div class="form-group">
    <label for="ia-pass">Password</label>
    <input type="password" id="ia-pass" placeholder="Choose a password" autocomplete="new-password">
  </div>
  <div class="form-group">
    <label for="ia-pass2">Confirm password</label>
    <input type="password" id="ia-pass2" placeholder="Confirm password" autocomplete="new-password">
  </div>
  <button class="btn btn-primary btn-full" id="ia-btn" onclick="doAcceptInvite()">Create account</button>
  <div class="error-msg" id="ia-err"></div>
</div>
</div>
</div>

<!-- ============================================================ DASHBOARD ============================================================ -->
<div id="view-dashboard" style="display:none">
<div class="wide">
  <div class="dash-header">
    <div class="dash-title">
      <img src="/favicon.svg" alt="Canary">
      <h1>Canary</h1>
    </div>
    <div class="dash-actions">
      <button class="btn btn-ghost btn-sm" onclick="showView('reports')">Reports</button>
      <button class="btn btn-ghost btn-sm" onclick="openInviteModal()">+ Invite member</button>
      <button class="btn btn-ghost btn-sm" onclick="doLogout()">Sign out</button>
    </div>
  </div>

  <div class="status-row">
    <div class="stat-card">
      <div class="stat-label">Status</div>
      <div class="stat-val ok" id="d-status">ok</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Monitors</div>
      <div class="stat-val" id="d-monitors">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Last cron tick</div>
      <div class="stat-sub" style="margin-top:10px" id="d-tick">—</div>
    </div>
  </div>

  <div class="section-header">
    <span class="section-title">Monitors</span>
    <div style="display:flex;gap:8px">
      <button class="btn btn-ghost btn-sm" onclick="openRelayModal()">+ Add relay</button>
      <button class="btn btn-ghost btn-sm" onclick="openIntegrationModal()">+ Add integration</button>
      <button class="btn btn-primary btn-sm" onclick="startWizard()">+ Add monitor</button>
    </div>
  </div>
  <div id="d-monitor-list">
    <div class="empty-state">
      <div style="font-size:32px">🐦</div>
      <p>No monitors yet. Add one to get started.</p>
    </div>
  </div>

  <div class="section-header" style="margin-top:36px">
    <span class="section-title">Secrets</span>
  </div>
  <p style="font-size:12px;color:#666;margin:-4px 0 12px">Reference a secret in a check's URL, headers, or body as <span style="font-family:ui-monospace,Menlo,monospace;color:#FFD700">{{KEY}}</span>. Values are write-only — injected server-side at request time, never shown again or written to logs.</p>
  <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
    <input id="sec-key" placeholder="KEY (letters, numbers, _)" style="flex:1;min-width:160px">
    <input id="sec-val" type="password" placeholder="value" style="flex:2;min-width:200px">
    <button class="btn btn-primary btn-sm" onclick="addSecret()">Save secret</button>
  </div>
  <div class="error-msg" id="sec-err"></div>
  <div id="d-secret-list"></div>
</div>
</div>

<!-- ============================================================ REPORTS ============================================================ -->
<div id="view-reports" style="display:none">
<div class="wide">
  <div class="dash-header">
    <div class="dash-title">
      <button class="wizard-back" onclick="showView('dashboard')" title="Back to dashboard">&#8592;</button>
      <h1>Reports</h1>
    </div>
    <div class="dash-actions" id="rep-window">
      <button class="btn btn-sm btn-primary" id="rep-win-24h" onclick="setReportWindow('24h')">24h</button>
      <button class="btn btn-sm btn-ghost" id="rep-win-7d" onclick="setReportWindow('7d')">7d</button>
      <button class="btn btn-sm btn-ghost" id="rep-win-30d" onclick="setReportWindow('30d')">30d</button>
    </div>
  </div>
  <p style="font-size:12px;color:#666;margin:-4px 0 16px">Recent fired checks for each configured monitor, newest first.</p>
  <div id="reports-list">
    <div class="empty-state"><div style="font-size:32px">📊</div><p>Loading…</p></div>
  </div>
</div>
</div>

<!-- ============================================================ WIZARD ============================================================ -->
<div id="view-wizard" style="display:none">
<div class="wide" style="max-width:620px">
  <div class="wizard-header">
    <button class="wizard-back" onclick="wizardBack()" title="Back">&#8592;</button>
    <div>
      <h2 style="margin:0;font-size:18px" id="wiz-title">Add monitor</h2>
      <div style="font-size:12px;color:var(--m);margin-top:2px" id="wiz-subtitle"></div>
    </div>
  </div>

  <div class="steps" id="wiz-steps">
    <div class="step active" id="wstep-1"><div class="step-num">1</div><span>Basics</span></div>
    <div class="step-line"></div>
    <div class="step" id="wstep-2"><div class="step-num">2</div><span>Check</span></div>
    <div class="step-line"></div>
    <div class="step" id="wstep-3"><div class="step-num">3</div><span>Alerts</span></div>
  </div>

  <!-- Step 1: Basics -->
  <div id="ws1">
    <div class="card">
      <div class="form-group">
        <label for="w-name">Monitor name *</label>
        <input type="text" id="w-name" placeholder="Production API">
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label for="w-desc">Description</label>
        <input type="text" id="w-desc" placeholder="What does this monitor watch?">
      </div>
    </div>
    <div class="wizard-footer">
      <button class="btn btn-ghost" onclick="showView('dashboard')">Cancel</button>
      <button class="btn btn-primary" id="ws1-btn" onclick="wizardStep1()">Next: Check config</button>
    </div>
    <div class="error-msg" id="ws1-err"></div>
  </div>

  <!-- Step 2: Check -->
  <div id="ws2" style="display:none">
    <div class="card">
      <div class="form-row col2">
        <div>
          <label for="w-method">Method</label>
          <select id="w-method">
            <option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option>
          </select>
        </div>
        <div>
          <label for="w-url">URL *</label>
          <input type="text" id="w-url" placeholder="https://api.example.com/health">
        </div>
      </div>
      <p style="font-size:12px;color:#666;margin:-6px 0 4px">Tip: inject a stored secret anywhere in the URL, headers, or body with <span style="font-family:ui-monospace,Menlo,monospace;color:#FFD700">{{KEY}}</span> — manage keys in the Secrets section on the dashboard.</p>

      <div class="form-group">
        <label>Headers <span style="color:var(--m);text-transform:none;font-weight:400">(optional)</span></label>
        <div id="headers-list" class="headers-list"></div>
        <button class="btn btn-ghost btn-sm" onclick="addHeaderRow()">+ Add header</button>
      </div>

      <div class="form-group" id="w-body-group" style="display:none">
        <label for="w-body">Request body <span style="color:var(--m);text-transform:none;font-weight:400">(JSON)</span></label>
        <textarea id="w-body" placeholder='{"key":"value"}'></textarea>
      </div>

      <hr class="divider">

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <label style="margin:0">Response — pick a value to compare</label>
        <button class="btn btn-ghost btn-sm" id="test-btn" onclick="testRequest()">Test request</button>
      </div>
      <div id="test-result" style="display:none;background:var(--bg);border:1px solid var(--b);border-radius:8px;padding:14px;margin-bottom:16px;font-family:'SF Mono','Fira Code',monospace;font-size:12px;line-height:1.7;max-height:260px;overflow:auto">
        <div id="test-result-inner"></div>
      </div>
      <div id="test-error" style="display:none;color:var(--red);font-size:13px;margin-bottom:12px"></div>

      <div class="toggle-row">
        <div>
          <div class="toggle-label">Report mode — no threshold, always send</div>
          <div class="toggle-desc">For digests/reports: skip the pass/fail comparison entirely. Every successful fetch counts as healthy and sends the alert (email &amp; ntfy) on this check's schedule. A fetch error still alerts as a failure. Use captures below to put the response's values in the message.</div>
        </div>
        <input type="checkbox" id="w-report-only" onchange="toggleReportMode()">
      </div>

      <div id="comparator-block">
      <div class="form-row col3">
        <div>
          <label for="w-expr">Response path *</label>
          <input type="text" id="w-expr" placeholder="data.value" oninput="updateComparatorHint()">
          <div class="hint">Dot-notation path into the response JSON</div>
        </div>
        <div>
          <label for="w-op">Comparator</label>
          <select id="w-op" onchange="updateComparatorHint()">
            <option value="gt">gt (&gt;)</option>
            <option value="lt">lt (&lt;)</option>
            <option value="gte">gte (&ge;)</option>
            <option value="lte">lte (&le;)</option>
            <option value="eq">eq (=)</option>
          </select>
        </div>
        <div>
          <label for="w-threshold">Threshold *</label>
          <input type="number" id="w-threshold" placeholder="100" oninput="updateComparatorHint()">
        </div>
      </div>
      <div id="comparator-hint" style="margin-top:10px;padding:10px 14px;background:#0f1a0f;border:1px solid #1a3a1a;border-radius:8px;font-size:13px;line-height:1.7;display:none"></div>
      </div>

      <div class="form-group" style="margin-top:12px">
        <label>Response captures <span style="color:var(--m);text-transform:none;font-weight:400">(optional — use values in alert messages)</span></label>
        <div id="captures-list" class="headers-list"></div>
        <button class="btn btn-ghost btn-sm" onclick="addCaptureRow()">+ Add capture</button>
        <div class="hint">Name a value from the response to use as <code style="background:#1a1a1a;padding:1px 5px;border-radius:3px">{name}</code> in alert messages. E.g. name=<em>callsLeft</em>, path=<em>data.remaining</em> → <em>{callsLeft}</em></div>
      </div>

      <hr class="divider">

      <div class="form-group" style="margin-bottom:12px">
        <label>Schedule</label>
        <div class="schedule-tabs">
          <button class="sched-tab active" id="sched-simple-tab" onclick="setSchedMode('simple')">Simple</button>
          <button class="sched-tab" id="sched-cron-tab" onclick="setSchedMode('cron')">Cron expression</button>
        </div>
      </div>

      <div id="sched-simple">
        <div class="form-row col3">
          <div>
            <label for="w-freq">Frequency</label>
            <select id="w-freq" onchange="updateSimpleSched()">
              <option value="daily">Daily</option>
              <option value="hourly">Hourly</option>
            </select>
          </div>
          <div id="sched-time-col">
            <label for="w-time">Time of day</label>
            <select id="w-time" onchange="updateSimpleSched()"></select>
          </div>
          <div id="sched-days-col">
            <label for="w-days">Days</label>
            <select id="w-days" onchange="updateSimpleSched()">
              <option value="daily">Every day</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekends">Weekends</option>
            </select>
          </div>
        </div>
        <div class="hint" id="sched-preview" style="margin-bottom:4px"></div>
      </div>

      <div id="sched-cron" style="display:none">
        <div class="form-group">
          <input type="text" id="w-cron" placeholder="*/5 * * * *">
          <div class="hint">5-field cron: minute hour day month weekday</div>
        </div>
      </div>

      <div class="toggle-row">
        <div>
          <div class="toggle-label">Notify on recover</div>
          <div class="toggle-desc">Send an alert when this monitor returns to healthy</div>
        </div>
        <input type="checkbox" id="w-recover">
      </div>
      <div class="toggle-row">
        <div>
          <div class="toggle-label">Notify on every run (all-clear)</div>
          <div class="toggle-desc">Also alert on healthy runs, not just failures — a passing run sends an "all clear" with the observed count (e.g. "0 errors found"). Fires on this check's schedule, to email &amp; ntfy recipients. SMS is skipped for all-clears so a heartbeat never texts you.</div>
        </div>
        <input type="checkbox" id="w-notify-success">
      </div>
      <div style="margin-top:12px">
        <label for="w-logs-url">Logs URL <span style="color:var(--m);text-transform:none;font-weight:400">(optional)</span></label>
        <input type="text" id="w-logs-url" placeholder="https://dash.deno.com/projects/…/logs">
        <div class="hint">A link to click through and verify the app. Shown in the default alert message; reference <code style="background:#1a1a1a;padding:1px 5px;border-radius:3px">{logsUrl}</code> to place it in a custom template.</div>
      </div>
    </div>
    <div class="wizard-footer">
      <button class="btn btn-ghost" onclick="wizardBack()">Back</button>
      <button class="btn btn-primary" id="ws2-btn" onclick="wizardStep2()">Next: Alert config</button>
    </div>
    <div class="error-msg" id="ws2-err"></div>
  </div>

  <!-- Step 3: Alerts -->
  <div id="ws3" style="display:none">
    <div style="display:flex;gap:0;margin-bottom:16px;border-bottom:1px solid #2a2a2a">
      <button id="ws3-tab-config" class="sched-tab active" onclick="ws3Tab('config')" style="padding:8px 20px">Configuration</button>
      <button id="ws3-tab-examples" class="sched-tab" onclick="ws3Tab('examples')" style="padding:8px 20px">Examples &amp; Try it</button>
      <button id="ws3-tab-webhook" class="sched-tab" onclick="ws3Tab('webhook')" style="padding:8px 20px">Webhook (push)</button>
    </div>

    <!-- Configuration tab -->
    <div id="ws3-config" class="card">
      <div style="padding-bottom:20px;margin-bottom:20px;border-bottom:1px solid #2a2a2a">
        <p style="font-size:11px;color:#FFD700;font-weight:600;letter-spacing:.08em;margin-bottom:14px">EMAIL</p>
        <div class="form-group">
          <label>EMAIL ADDRESS <span style="color:#555;font-weight:400">(leave blank to skip email alerts)</span></label>
          <input type="text" id="w-email-addr" placeholder="oncall@example.com">
        </div>
        <div class="form-group">
          <label>EMAIL SUBJECT <span style="color:#555;font-weight:400">(optional)</span></label>
          <input type="text" id="w-email-subject" placeholder="Canary Alert: {monitor} {status}">
          <div class="var-chips">
            <span class="var-chips-label">Insert:</span>
            <button type="button" class="var-chip" onclick="insertVar('w-email-subject','{monitor}')">{monitor}<span class="var-chip-example">Conf Alert</span></button>
            <button type="button" class="var-chip" onclick="insertVar('w-email-subject','{status}')">{status}<span class="var-chip-example">FAILED</span></button>
          </div>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label>EMAIL MESSAGE <span style="color:#555;font-weight:400">(optional)</span></label>
          <textarea id="w-email-message" rows="3" placeholder="Leave blank for default" style="width:100%;background:#111;border:1px solid #2a2a2a;border-radius:6px;padding:10px 12px;color:#e0e0e0;font-size:13px;resize:vertical;box-sizing:border-box"></textarea>
          <div class="var-chips">
            <span class="var-chips-label">Insert:</span>
            <button type="button" class="var-chip" onclick="insertVar('w-email-message','{monitor}')">{monitor}<span class="var-chip-example">Conf Alert</span></button>
            <button type="button" class="var-chip" onclick="insertVar('w-email-message','{status}')">{status}<span class="var-chip-example">FAILED</span></button>
            <button type="button" class="var-chip" onclick="insertVar('w-email-message','{observed}')">{observed}<span class="var-chip-example">141</span></button>
            <button type="button" class="var-chip" onclick="insertVar('w-email-message','{timestamp}')">{timestamp}<span class="var-chip-example">2026-06-01T18:44Z</span></button>
            <button type="button" class="var-chip" onclick="insertVar('w-email-message','{logsUrl}')">{logsUrl}<span class="var-chip-example">logs link</span></button>
            <span class="var-chips-label">+ any capture names you defined</span>
          </div>
        </div>
      </div>
      <div style="padding-bottom:20px;margin-bottom:20px;border-bottom:1px solid #2a2a2a">
        <p style="font-size:11px;color:#FFD700;font-weight:600;letter-spacing:.08em;margin-bottom:14px">SMS</p>
        <div class="form-group">
          <label>PHONE NUMBERS <span style="color:#555;font-weight:400">(leave blank to skip SMS alerts)</span></label>
          <div id="w-sms-list"></div>
          <button type="button" class="btn btn-ghost btn-sm" id="w-sms-add-btn" onclick="addSmsRow()">+ Add number</button>
          <p class="help-text">10 or 11 digits, no + prefix (e.g. 18432222986). Up to 5 numbers; sent 4 seconds apart.</p>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label>SMS MESSAGE <span style="color:#555;font-weight:400">(optional)</span></label>
          <input type="text" id="w-sms-message" placeholder="Leave blank for default">
          <div class="var-chips">
            <span class="var-chips-label">Insert:</span>
            <button type="button" class="var-chip" onclick="insertVar('w-sms-message','{monitor}')">{monitor}<span class="var-chip-example">Conf Alert</span></button>
            <button type="button" class="var-chip" onclick="insertVar('w-sms-message','{status}')">{status}<span class="var-chip-example">FAILED</span></button>
            <button type="button" class="var-chip" onclick="insertVar('w-sms-message','{observed}')">{observed}<span class="var-chip-example">141</span></button>
            <button type="button" class="var-chip" onclick="insertVar('w-sms-message','{timestamp}')">{timestamp}<span class="var-chip-example">2026-06-01T18:44Z</span></button>
            <span class="var-chips-label">+ captures</span>
          </div>
        </div>
      </div>
      <div>
        <p style="font-size:11px;color:#FFD700;font-weight:600;letter-spacing:.08em;margin-bottom:14px">NTFY (PUSH)</p>
        <div class="form-group">
          <label>NTFY TOPIC OR URL <span style="color:#555;font-weight:400">(leave blank to skip ntfy alerts)</span></label>
          <input type="text" id="w-ntfy-addr" placeholder="adam-code-alerts or ntfy.sh/adam-code-alerts">
          <p class="help-text">Topic name (assumes ntfy.sh) or full URL for self-hosted</p>
        </div>
        <div class="form-group">
          <label>NTFY TITLE <span style="color:#555;font-weight:400">(optional)</span></label>
          <input type="text" id="w-ntfy-title" placeholder="Canary: {monitor} {status}">
          <div class="var-chips">
            <span class="var-chips-label">Insert:</span>
            <button type="button" class="var-chip" onclick="insertVar('w-ntfy-title','{monitor}')">{monitor}<span class="var-chip-example">Conf Alert</span></button>
            <button type="button" class="var-chip" onclick="insertVar('w-ntfy-title','{status}')">{status}<span class="var-chip-example">FAILED</span></button>
          </div>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label style="display:flex;justify-content:space-between;align-items:center">
            <span>NTFY MESSAGE <span style="color:#555;font-weight:400">(optional)</span></span>
            <button type="button" class="btn btn-ghost btn-sm" onclick="insertDefaultNtfyMessage()" style="font-size:11px;padding:4px 10px">Insert default</button>
          </label>
          <textarea id="w-ntfy-message" rows="5" placeholder="Leave blank for default. Multi-line OK." style="width:100%;background:#111;border:1px solid #2a2a2a;border-radius:6px;padding:10px 12px;color:#e0e0e0;font-size:13px;font-family:monospace;resize:vertical;box-sizing:border-box"></textarea>
          <div class="var-chips">
            <span class="var-chips-label">Insert:</span>
            <button type="button" class="var-chip" onclick="insertVar('w-ntfy-message','{monitor}')">{monitor}<span class="var-chip-example">Conf Alert</span></button>
            <button type="button" class="var-chip" onclick="insertVar('w-ntfy-message','{status}')">{status}<span class="var-chip-example">FAILED</span></button>
            <button type="button" class="var-chip" onclick="insertVar('w-ntfy-message','{observed}')">{observed}<span class="var-chip-example">141</span></button>
            <button type="button" class="var-chip" onclick="insertVar('w-ntfy-message','{timestamp}')">{timestamp}<span class="var-chip-example">2026-06-01T18:44Z</span></button>
            <span class="var-chips-label">+ captures</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Examples & Try it tab -->
    <div id="ws3-examples" style="display:none">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px">
        <div class="card">
          <p style="font-size:11px;color:#FFD700;font-weight:600;letter-spacing:.08em;margin-bottom:12px">EMAIL EXAMPLE</p>
          <div style="background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:14px;font-size:12px;color:#999;font-family:monospace;margin-bottom:16px;line-height:1.8">
            <span style="color:#e0e0e0">Subject:</span> Canary Alert: Example Monitor FAILED<br>
            <br>
            <span style="color:#e0e0e0">Status:</span>    ❌ FAILED<br>
            <span style="color:#e0e0e0">Monitor:</span>   Example Monitor<br>
            <span style="color:#e0e0e0">Observed:</span>  42<br>
            <span style="color:#e0e0e0">Run ID:</span>    test-1234<br>
            <span style="color:#e0e0e0">Timestamp:</span> 2026-03-17T11:00:00.000Z
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" id="ex-email-addr" placeholder="your@email.com" style="flex:1">
            <button class="btn btn-ghost btn-sm" id="ex-email-btn" onclick="sendTestAlert('email')">Send test</button>
          </div>
          <div id="ex-email-result" style="font-size:12px;margin-top:8px"></div>
        </div>
        <div class="card">
          <p style="font-size:11px;color:#FFD700;font-weight:600;letter-spacing:.08em;margin-bottom:12px">SMS EXAMPLE</p>
          <div style="background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:14px;font-size:12px;color:#999;font-family:monospace;margin-bottom:16px;line-height:1.8">
            Canary FAILED: Example Monitor — observed: 42 at 2026-03-17T11:00:00.000Z
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" id="ex-sms-addr" placeholder="15555550100" style="flex:1">
            <button class="btn btn-ghost btn-sm" id="ex-sms-btn" onclick="sendTestAlert('sms')">Send test</button>
          </div>
          <div id="ex-sms-result" style="font-size:12px;margin-top:8px"></div>
        </div>
        <div class="card">
          <p style="font-size:11px;color:#FFD700;font-weight:600;letter-spacing:.08em;margin-bottom:12px">NTFY EXAMPLE</p>
          <div style="background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:14px;font-size:12px;color:#999;font-family:monospace;margin-bottom:16px;line-height:1.8">
            <span style="color:#e0e0e0">Title:</span> Canary: Example Monitor FAILED<br>
            <span style="color:#e0e0e0">Priority:</span> high<br>
            <br>
            FAILED<br>
            Monitor: Example Monitor<br>
            Observed: 42<br>
            Timestamp: 2026-03-17T11:00:00.000Z
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" id="ex-ntfy-addr" placeholder="adam-code-alerts" style="flex:1">
            <button class="btn btn-ghost btn-sm" id="ex-ntfy-btn" onclick="sendTestAlert('ntfy')">Send test</button>
          </div>
          <div id="ex-ntfy-result" style="font-size:12px;margin-top:8px"></div>
        </div>
      </div>
    </div>

    <!-- Webhook (push) tab -->
    <div id="ws3-webhook" style="display:none">
      <div class="card" style="margin-bottom:16px">
        <p style="font-size:11px;color:#FFD700;font-weight:600;letter-spacing:.08em;margin-bottom:14px">HOW IT WORKS</p>
        <p style="font-size:13px;color:var(--m);margin-bottom:0;line-height:1.6">
          Other projects POST to canary with a per-monitor bearer secret. Canary verifies it, writes a run result, and dispatches alerts through the SMS / email / ntfy recipients configured on the Configuration tab — same templating, same recovery semantics as a cron-driven check. Use this as a single alert hub for your whole stack: one place to manage who gets paged, every project pipes its events through.
        </p>
      </div>

      <div class="card" style="margin-bottom:16px">
        <p style="font-size:11px;color:#FFD700;font-weight:600;letter-spacing:.08em;margin-bottom:8px">EXAMPLE FIRE</p>
        <p style="font-size:12px;color:#666;margin-bottom:10px" id="wh-curl-label">Generate a key below to fill in the real secret. Until then this shows the call shape with a placeholder.</p>
        <pre id="wh-curl-pre" style="background:#111;border:1px solid #2a2a2a;border-radius:6px;padding:12px;color:#e0e0e0;font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.5;overflow-x:auto;margin:0;white-space:pre-wrap;word-break:break-all"></pre>
      </div>

      <div class="card" style="margin-bottom:16px">
        <p style="font-size:11px;color:#FFD700;font-weight:600;letter-spacing:.08em;margin-bottom:10px">PAYLOAD FIELDS (all optional)</p>
        <div style="font-size:12px;color:#e0e0e0;line-height:1.7;font-family:ui-monospace,Menlo,monospace">
          <div><span style="color:#FFD700">passed</span> <span style="color:#666">bool, default false</span> — false fires failure, true fires recovery (only if prior was failure)</div>
          <div><span style="color:#FFD700">observed</span> <span style="color:#666">number, default 0</span> — surfaces as <span style="color:#FFD700">{observed}</span> in templates</div>
          <div><span style="color:#FFD700">error</span> <span style="color:#666">string</span> — surfaces as <span style="color:#FFD700">{error}</span> and in default body</div>
          <div><span style="color:#FFD700">captures</span> <span style="color:#666">object</span> — merged into <span style="color:#FFD700">{var}</span> table, e.g. <span style="color:#FFD700">{"service":"auth-api"}</span> → <span style="color:#FFD700">{service}</span></div>
          <div><span style="color:#FFD700">message</span> <span style="color:#666">string</span> — overrides every channel's message for this fire</div>
          <div><span style="color:#FFD700">title</span> <span style="color:#666">string</span> — overrides ntfy title / email subject for this fire</div>
        </div>
        <p style="font-size:12px;color:#666;margin-top:12px;margin-bottom:0">Response: <span style="color:#e0e0e0;font-family:ui-monospace,Menlo,monospace">{ runId, fired, channels }</span> on success, <span style="color:#e0e0e0;font-family:ui-monospace,Menlo,monospace">401</span> on bad secret, <span style="color:#e0e0e0;font-family:ui-monospace,Menlo,monospace">404</span> on unknown monitor.</p>
      </div>

      <div class="card">
        <p style="font-size:11px;color:#FFD700;font-weight:600;letter-spacing:.08em;margin-bottom:14px">WEBHOOK KEY</p>
        <div id="wh-state" style="margin-bottom:0">
          <p style="font-size:12px;color:#666;margin:0">Save the alert first, then come back here to generate a key.</p>
        </div>
        <div id="wh-secret-display" style="display:none;margin-top:14px">
          <div class="success-msg" style="display:block;margin-bottom:10px">⚠️ Save this secret now — it will not be shown again.</div>
          <pre id="wh-secret-pre" style="background:#111;border:1px solid #FFD700;border-radius:6px;padding:12px;color:#FFD700;font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all;white-space:pre-wrap;margin:0"></pre>
          <button type="button" class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="copyWebhookSecret()">Copy to clipboard</button>
        </div>
      </div>
    </div>

    <div class="wizard-footer">
      <button class="btn btn-ghost" onclick="wizardBack()">Back</button>
      <button class="btn btn-primary" id="ws3-btn" onclick="wizardStep3()">Save monitor</button>
    </div>
    <div class="error-msg" id="ws3-err"></div>
    <div class="success-msg" id="ws3-ok"></div>
  </div>
</div>
</div>

<!-- ============================================================ INVITE MODAL ============================================================ -->
<div class="modal-overlay" id="invite-modal">
<div class="modal">
  <div class="modal-header">
    <h2>Invite members</h2>
    <button class="modal-close" onclick="closeInviteModal()">&#x2715;</button>
  </div>
  <p style="font-size:13px;color:var(--m);margin-bottom:20px">Enter up to 10 email addresses. Each person will receive an invite link to set their password.</p>
  <div id="invite-emails"></div>
  <button class="btn btn-ghost btn-sm" id="invite-add-btn" onclick="addInviteEmail()">+ Add another</button>
  <hr class="divider">
  <div style="display:flex;gap:10px;justify-content:flex-end">
    <button class="btn btn-ghost" onclick="closeInviteModal()">Cancel</button>
    <button class="btn btn-primary" id="invite-send-btn" onclick="sendInvites()">Send invitations</button>
  </div>
  <div class="error-msg" id="invite-err"></div>
  <div class="success-msg" id="invite-ok"></div>
</div>
</div>

<!-- ============================================================ INTEGRATION MODAL ============================================================ -->
<div class="modal-overlay" id="integration-modal">
<div class="modal" style="max-width:520px">
  <div class="modal-header">
    <h2>Add integration</h2>
    <button class="modal-close" onclick="closeIntegrationModal()">&#x2715;</button>
  </div>
  <p style="font-size:13px;color:var(--m);margin-bottom:20px">Monitor a project that exposes the Canary health contract (<code>POST &lt;base URL&gt;/canary/errors</code> → <code>{ totalErrors }</code>). Canary polls it on a schedule and alerts when <code>totalErrors &gt; 0</code> or the endpoint is unreachable.</p>
  <div class="form-group">
    <label for="ig-name">Project name *</label>
    <input type="text" id="ig-name" placeholder="autobottom">
  </div>
  <div class="form-group">
    <label for="ig-url">Base URL *</label>
    <input type="text" id="ig-url" placeholder="https://autobottom.thetechgoose.deno.net">
  </div>
  <div class="form-group">
    <label for="ig-secret">Bearer secret *</label>
    <input type="password" id="ig-secret" placeholder="the project's CANARY_SECRET" autocomplete="off">
  </div>
  <div class="form-group">
    <label for="ig-cron">Schedule (cron, optional)</label>
    <input type="text" id="ig-cron" placeholder="default: 0 13 * * * (daily ~9am ET)">
  </div>
  <label>Alert recipients * (at least one)</label>
  <div class="form-group">
    <input type="text" id="ig-email" placeholder="Email address">
  </div>
  <div class="form-group">
    <input type="text" id="ig-sms" placeholder="SMS number">
  </div>
  <div class="form-group">
    <input type="text" id="ig-ntfy" placeholder="ntfy topic">
  </div>
  <hr class="divider">
  <div style="display:flex;gap:10px;justify-content:flex-end">
    <button class="btn btn-ghost" onclick="closeIntegrationModal()">Cancel</button>
    <button class="btn btn-primary" id="ig-submit-btn" onclick="submitIntegration()">Create &amp; verify</button>
  </div>
  <div class="error-msg" id="ig-err"></div>
  <div class="success-msg" id="ig-ok"></div>
  <div id="ig-result" style="margin-top:12px"></div>
</div>
</div>

<!-- ============================================================ RELAY MODAL ============================================================ -->
<div class="modal-overlay" id="relay-modal">
<div class="modal" style="max-width:520px">
  <div class="modal-header">
    <h2 id="relay-modal-title">Add relay</h2>
    <button class="modal-close" onclick="closeRelayModal()">&#x2715;</button>
  </div>
  <p style="font-size:13px;color:var(--m);margin-bottom:20px">A <strong>relay</strong> is a monitor that forwards a raw error straight to SMS. Another project POSTs <code>{ "test": "&lt;token&gt;", "error": "…" }</code> to its fire URL — no cron, no check. It shows in the monitor list and Reports like any monitor.</p>
  <div class="form-group">
    <label for="relay-name">Relay name *</label>
    <input type="text" id="relay-name" placeholder="payments-sms">
  </div>
  <div class="form-group">
    <label for="relay-numbers">SMS numbers * (comma-separated, up to 5)</label>
    <input type="text" id="relay-numbers" placeholder="18432222986, 18435551234">
  </div>
  <div class="form-group">
    <label for="relay-token" id="relay-token-label">Token * (min 16 chars)</label>
    <input type="password" id="relay-token" placeholder="a long, high-entropy shared secret" autocomplete="off">
  </div>
  <div class="form-group">
    <label for="relay-template">Message template (optional)</label>
    <input type="text" id="relay-template" placeholder="🚨 {monitor}: {error}">
  </div>
  <hr class="divider">
  <div style="display:flex;gap:10px;justify-content:flex-end">
    <button class="btn btn-ghost" onclick="closeRelayModal()">Cancel</button>
    <button class="btn btn-primary" id="relay-submit-btn" onclick="submitRelay()">Create relay</button>
  </div>
  <div class="error-msg" id="relay-err"></div>
  <div class="success-msg" id="relay-ok"></div>
  <div id="relay-result" style="margin-top:12px"></div>
</div>
</div>

<!-- ============================================================ RUN DETAIL MODAL ============================================================ -->
<div class="modal-overlay" id="run-detail-modal">
<div class="modal" style="max-width:760px">
  <div class="modal-header">
    <h2>Run detail</h2>
    <div style="display:flex;align-items:center;gap:8px">
      <button class="btn btn-ghost btn-sm" type="button" data-copy="all" id="run-detail-copy-all" style="display:none">Copy all</button>
      <button class="modal-close" onclick="closeRunDetail()">&#x2715;</button>
    </div>
  </div>
  <div id="run-detail-body">
    <div class="empty-state"><div style="font-size:32px">📊</div><p>Loading…</p></div>
  </div>
</div>
</div>

<script>
// ─── State ───────────────────────────────────────────────────────────────────
const S = {
  token: localStorage.getItem('canary_token'),
  wizardMonitorId: null,
  wizardMode: 'create', // 'create' | 'edit-check' | 'edit-alert'
  schedMode: 'simple',
  reportWindow: '24h', // '24h' | '7d' | '30d'
};

// ─── API ─────────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.token) headers['Authorization'] = 'Bearer ' + S.token;
  const controller = new AbortController();
  const timer = setTimeout(() => { console.error('❌ api: timeout after 15s', method, path); controller.abort(); }, 15000);
  // Never log request bodies that may carry a secret value: /secrets posts the
  // plaintext secretValue, which is a write-only/never-logged value. Redact the
  // body for those routes so the plaintext can't leak into devtools, console
  // capture, or a screen share.
  const bodyForLog = body === undefined
    ? '(no body)'
    : path.indexOf('/secrets') === 0
    ? '(redacted)'
    : JSON.stringify(body).slice(0, 120);
  console.log('🔍 api:', method, path, bodyForLog);
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    console.error('❌ api: fetch failed', method, path, err.message);
    throw new Error(err.name === 'AbortError' ? 'Request timed out after 15s' : 'Network error: ' + err.message);
  }
  clearTimeout(timer);
  console.log('✅ api:', method, path, '→', res.status);
  const data = await res.json().catch(() => ({}));
  // The 401 interceptor exists to catch an EXPIRED session on an authenticated
  // route (clear the token, bounce to login). It must NOT fire on the public
  // auth/invite endpoints: a wrong password on /auth/login legitimately returns
  // 401, and masking it as "Session expired" is misleading on a first sign-in
  // where there is no session. For those, fall through to surface data.message
  // (e.g. "Invalid credentials").
  const isPublicAuthPath = path === '/auth/login' || path.indexOf('/invite/') === 0;
  if (res.status === 401 && !isPublicAuthPath) {
    console.warn('⚠️ api: 401 — clearing token and redirecting to login');
    localStorage.removeItem('canary_token');
    S.token = null;
    showView('login');
    throw new Error('Session expired — please log in again');
  }
  if (!res.ok) throw new Error(data.message || 'Request failed (' + res.status + ')');
  return data;
}

// ─── View router ─────────────────────────────────────────────────────────────
function showView(name) {
  ['login','invite-accept','dashboard','wizard','reports'].forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) el.style.display = 'none';
  });
  const el = document.getElementById('view-' + name);
  if (el) el.style.display = name === 'login' || name === 'invite-accept' ? 'flex' : 'block';
  if (name === 'dashboard') loadDashboard();
  if (name === 'reports') loadReports();
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function doLogin() {
  const username = document.getElementById('li-user').value.trim();
  const password = document.getElementById('li-pass').value;
  const btn = document.getElementById('li-btn');
  const err = document.getElementById('li-err');
  if (!username || !password) { err.textContent = 'Username and password are required.'; return; }
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Signing in...'; err.textContent = '';
  try {
    const data = await api('POST', '/auth/login', { username, password });
    S.token = data.token;
    localStorage.setItem('canary_token', data.token);
    showView('dashboard');
  } catch (e) { err.textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = 'Sign in'; }
}

async function doLogout() {
  if (S.token) api('POST', '/auth/logout').catch(() => {});
  S.token = null;
  localStorage.removeItem('canary_token');
  showView('login');
}

// ─── Invite accept ───────────────────────────────────────────────────────────
async function initInviteAccept() {
  const token = new URLSearchParams(location.search).get('token');
  if (!token) { showView('login'); return; }

  try {
    const d = await api('GET', '/invite/info?token=' + encodeURIComponent(token));
    const emailEl = document.getElementById('ia-email');
    emailEl.value = d.email;
    emailEl.placeholder = d.email;
    // Also update the subtitle so the email is visible even before focusing the field
    document.getElementById('ia-email-display').textContent = d.email;
  } catch (e) {
    document.getElementById('ia-err').textContent = 'This invite link is invalid or has expired. Ask your admin to send a new one.';
    document.getElementById('ia-btn').disabled = true;
  }

  document.getElementById('ia-btn').onclick = () => doAcceptInvite(token);
}

async function doAcceptInvite(token) {
  const pass = document.getElementById('ia-pass').value;
  const pass2 = document.getElementById('ia-pass2').value;
  const btn = document.getElementById('ia-btn');
  const err = document.getElementById('ia-err');
  if (!pass) { err.textContent = 'Please choose a password.'; return; }
  if (pass !== pass2) { err.textContent = 'Passwords do not match.'; return; }
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Creating account...'; err.textContent = '';
  try {
    const data = await api('POST', '/invite/accept', { token, password: pass });
    S.token = data.token;
    localStorage.setItem('canary_token', data.token);
    history.replaceState(null, '', '/');
    showView('dashboard');
  } catch (e) { err.textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = 'Create account'; }
}

// ─── Dashboard ───────────────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const status = await api('GET', '/api/status');
    document.getElementById('d-status').textContent = status.status || 'ok';
    document.getElementById('d-monitors').textContent = status.monitors ?? '—';
    document.getElementById('d-tick').textContent = status.lastCronTick
      ? new Date(status.lastCronTick).toLocaleString() : 'Not yet ticked';
  } catch (e) {
    console.error('❌ loadDashboard: /api/status failed:', e.message);
  }

  try {
    const data = await api('GET', '/monitors');
    renderMonitorList(data.monitors || []);
  } catch (e) {
    console.error('❌ loadDashboard: /monitors failed:', e.message);
    const el = document.getElementById('d-monitor-list');
    if (el) el.innerHTML = '<div class="empty-state"><div style="font-size:32px">⚠️</div><p>Could not load monitors: ' + esc(e.message) + '</p></div>';
  }

  loadSecrets();
}

async function loadSecrets() {
  const listEl = document.getElementById('d-secret-list');
  if (!listEl) return;
  try {
    const data = await api('GET', '/secrets');
    const secrets = data.secrets || [];
    if (!secrets.length) {
      listEl.innerHTML = '<div class="stat-sub" style="padding:6px 0">No secrets yet.</div>';
      return;
    }
    // Delete buttons use data-* + delegation (keys are user-controlled).
    listEl.innerHTML = secrets.map(s =>
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border:1px solid #222;border-radius:6px;margin-bottom:6px">'
      + '<span style="font-family:ui-monospace,Menlo,monospace;color:#FFD700">{{' + esc(s.secretKey) + '}}</span>'
      + '<button class="btn btn-ghost btn-sm" data-del-secret="' + esc(s.secretKey) + '">Delete</button>'
      + '</div>'
    ).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="error-msg" style="display:block">' + esc(e.message) + '</div>';
  }
}

async function addSecret() {
  const key = document.getElementById('sec-key').value.trim();
  const val = document.getElementById('sec-val').value;
  const err = document.getElementById('sec-err');
  err.textContent = ''; err.style.display = 'none';
  const fail = (m) => { err.textContent = m; err.style.display = 'block'; };
  if (!key) return fail('Secret key is required.');
  if (!/^[A-Za-z0-9_]+$/.test(key)) return fail('Key may only contain letters, numbers, and underscores.');
  if (!val) return fail('Secret value is required.');
  try {
    await api('POST', '/secrets', { secretKey: key, secretValue: val });
    document.getElementById('sec-key').value = '';
    document.getElementById('sec-val').value = '';
    loadSecrets();
  } catch (e) { fail(e.message); }
}

async function deleteSecret(key) {
  if (!confirm('Delete secret {{' + key + '}}? Checks referencing it will fail until it is replaced.')) return;
  try {
    await api('DELETE', '/secrets/' + encodeURIComponent(key));
    loadSecrets();
  } catch (e) {
    const err = document.getElementById('sec-err');
    err.textContent = e.message; err.style.display = 'block';
  }
}

// ─── Relays (monitors of type "relay") ─────────────────────────────────────────
// _relayEditId is null for a create, or the monitorId being reconfigured.
let _relayEditId = null;

function openRelayModal() {
  _relayEditId = null;
  document.getElementById('relay-modal-title').textContent = 'Add relay';
  document.getElementById('relay-submit-btn').textContent = 'Create relay';
  ['relay-name','relay-numbers','relay-token','relay-template'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('relay-name').disabled = false;
  document.getElementById('relay-token-label').textContent = 'Token * (min 16 chars)';
  document.getElementById('relay-err').textContent = '';
  document.getElementById('relay-ok').textContent = '';
  document.getElementById('relay-result').innerHTML = '';
  document.getElementById('relay-modal').classList.add('open');
  document.getElementById('relay-name').focus();
}

async function editRelay(monitorId) {
  _relayEditId = monitorId;
  document.getElementById('relay-modal-title').textContent = 'Edit relay';
  document.getElementById('relay-submit-btn').textContent = 'Save relay';
  // Name is the monitor's — rename via "Edit details", not here — so lock it.
  const nameEl = document.getElementById('relay-name');
  nameEl.value = _monitorNames[monitorId] || ''; nameEl.disabled = true;
  document.getElementById('relay-token').value = '';
  // On edit the token is optional (blank = keep current); say so.
  document.getElementById('relay-token-label').textContent = 'Token (blank = keep current)';
  document.getElementById('relay-numbers').value = '';
  document.getElementById('relay-template').value = '';
  document.getElementById('relay-err').textContent = '';
  document.getElementById('relay-ok').textContent = '';
  // Surface the fire URL so it's retrievable any time after create.
  document.getElementById('relay-result').innerHTML = '<div style="font-size:13px;border:1px solid var(--b);border-radius:8px;padding:12px">'
    + '<div style="margin-bottom:6px;color:var(--m)">Fire it: POST here with <code>Authorization: Bearer &lt;token&gt;</code> and a JSON body like <code>{ "error": "…" }</code> (extra fields become captures):</div>'
    + '<pre style="white-space:pre-wrap;word-break:break-all;font-size:12px;margin:0">' + esc(relayFireUrl(monitorId)) + '</pre>'
    + '</div>';
  document.getElementById('relay-modal').classList.add('open');
  try {
    const cfg = await api('GET', '/monitors/' + encodeURIComponent(monitorId) + '/relay');
    document.getElementById('relay-numbers').value = (cfg.numbers || []).join(', ');
  } catch (e) {
    document.getElementById('relay-err').textContent = 'Could not load relay config: ' + e.message;
  }
}

function closeRelayModal() {
  document.getElementById('relay-modal').classList.remove('open');
}

async function submitRelay() {
  const name = document.getElementById('relay-name').value.trim();
  const numbersRaw = document.getElementById('relay-numbers').value;
  const token = document.getElementById('relay-token').value;
  const template = document.getElementById('relay-template').value.trim();
  const err = document.getElementById('relay-err');
  const ok = document.getElementById('relay-ok');
  const result = document.getElementById('relay-result');
  err.textContent = ''; ok.textContent = ''; result.innerHTML = '';
  const fail = (m) => { err.textContent = m; };
  // Presence checks only — the server (relay-configure.ts) is the source of truth
  // for format rules (token length, digit/number caps) and its 400s surface here.
  const numbers = numbersRaw.split(',').map(s => s.trim()).filter(Boolean);
  if (!_relayEditId && !name) return fail('Relay name is required.');
  if (!numbers.length) return fail('At least one SMS number is required.');
  if (!_relayEditId && !token) return fail('A token is required.');

  const btn = document.getElementById('relay-submit-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Saving...';
  try {
    if (_relayEditId) {
      const body = { numbers: numbers };
      if (token) body.token = token;
      if (template) body.template = template;
      await api('POST', '/monitors/' + encodeURIComponent(_relayEditId) + '/relay', body);
      ok.textContent = 'Relay updated!';
      loadDashboard();
      setTimeout(closeRelayModal, 1200);
    } else {
      const body = { name: name, numbers: numbers, token: token };
      if (template) body.template = template;
      const res = await api('POST', '/relays', body);
      ok.textContent = 'Relay created! Fire URL: ' + relayFireUrl(res.monitorId) + ' (also under Edit relay)';
      loadDashboard();
      // Close shortly after so the success/URL is readable but the modal doesn't
      // linger; the fire URL stays retrievable from the relay card's Edit relay.
      setTimeout(closeRelayModal, 2500);
    }
  } catch (e) { fail(e.message); }
  finally { btn.disabled = false; btn.textContent = _relayEditId ? 'Save relay' : 'Create relay'; }
}

// The fire URL is keyed by monitorId (rename-safe), mirroring /webhook/:id/fire.
function relayFireUrl(monitorId) {
  return location.origin + '/relay/' + monitorId + '/fire';
}

// Named onDeleteMonitor (not deleteMonitor) to avoid colliding with the
// server-side deleteMonitor import at the top of this file.
async function onDeleteMonitor(monitorId) {
  const name = _monitorNames[monitorId] || monitorId;
  if (!confirm('Delete monitor "' + name + '"? This permanently removes it and all its history (check, alert, webhook, relay, runs). This cannot be undone.')) return;
  try {
    await api('DELETE', '/monitors/' + encodeURIComponent(monitorId));
    loadDashboard();
  } catch (e) {
    alert('Could not delete monitor: ' + e.message);
  }
}

// Monitor names by id — a render-time map so the (user-controlled) name is never
// interpolated into an inline onclick attribute (delete uses the id, shows name).
let _monitorNames = {};
function renderMonitorList(monitors) {
  const el = document.getElementById('d-monitor-list');
  if (!monitors.length) {
    el.innerHTML = '<div class="empty-state"><div style="font-size:32px">🐦</div><p>No monitors yet. Add one to get started.</p></div>';
    return;
  }
  _monitorNames = {};
  el.innerHTML = monitors.map(m => {
    _monitorNames[m.monitorId] = m.name;
    const isRelay = m.type === 'relay';
    const badge = isRelay
      ? '<span style="margin-left:8px;font-size:10px;font-weight:700;letter-spacing:.04em;color:#FFD700;border:1px solid #FFD70055;border-radius:4px;padding:1px 6px;vertical-align:middle">RELAY</span>'
      : '';
    // Type-specific actions, then a shared "Delete" that removes the whole monitor.
    const specific = isRelay
      ? \`<button class="btn btn-ghost btn-sm" onclick="editDetails('\${esc(m.monitorId)}')">Edit details</button>
         <button class="btn btn-ghost btn-sm" onclick="editRelay('\${esc(m.monitorId)}')">Edit relay</button>\`
      : \`<button class="btn btn-ghost btn-sm" onclick="editDetails('\${esc(m.monitorId)}')">Edit details</button>
         <button class="btn btn-ghost btn-sm" onclick="editCheck('\${esc(m.monitorId)}')">Edit check</button>
         <button class="btn btn-ghost btn-sm" onclick="editAlert('\${esc(m.monitorId)}')">Edit alert</button>
         <button class="btn btn-ghost btn-sm" onclick="duplicateMonitor('\${esc(m.monitorId)}')">Duplicate</button>
         <button class="btn btn-ghost btn-sm" onclick="runNow('\${esc(m.monitorId)}', this)">Run now</button>\`;
    return \`<div class="monitor-card">
      <div class="monitor-info"><h3>\${esc(m.name)}\${badge}</h3><p>\${esc(m.description || 'No description')}</p></div>
      <div class="monitor-actions">\${specific}
        <button class="btn btn-danger btn-sm" onclick="onDeleteMonitor('\${esc(m.monitorId)}')">Delete</button>
      </div>
    </div>\`;
  }).join('');
}

// ─── Reports ───────────────────────────────────────────────────────────────────
function setReportWindow(w) {
  S.reportWindow = w;
  ['24h','7d','30d'].forEach(x => {
    const b = document.getElementById('rep-win-' + x);
    if (b) b.className = 'btn btn-sm ' + (x === w ? 'btn-primary' : 'btn-ghost');
  });
  loadReports();
}

async function loadReports() {
  const el = document.getElementById('reports-list');
  if (!el) return;
  el.innerHTML = '<div class="empty-state"><div style="font-size:32px">📊</div><p>Loading…</p></div>';
  try {
    const data = await api('GET', '/api/reports?window=' + encodeURIComponent(S.reportWindow));
    renderReports(data.reports || []);
  } catch (e) {
    console.error('❌ loadReports failed:', e.message);
    el.innerHTML = '<div class="empty-state"><div style="font-size:32px">⚠️</div><p>Could not load reports: ' + esc(e.message) + '</p></div>';
  }
}

function renderReports(reports) {
  const el = document.getElementById('reports-list');
  if (!reports.length) {
    el.innerHTML = '<div class="empty-state"><div style="font-size:32px">🐦</div><p>No monitors yet. Add one to start collecting check history.</p></div>';
    return;
  }
  el.innerHTML = reports.map(rep => {
    const total = rep.total || 0;
    const rate = total ? Math.round((rep.passed / total) * 100) : 0;
    const summary = total
      ? '<span style="color:var(--green)">' + rep.passed + '/' + total + ' passed</span>'
        + (rep.failed ? ' · <span style="color:var(--red)">' + rep.failed + ' failed</span>' : '')
        + ' · ' + rate + '%'
      : '<span style="color:var(--m)">No runs in this window</span>';
    const ctx = rep.type === 'relay'
      ? '<div style="font-size:12px;color:var(--m);margin-top:4px">📮 Inbound SMS relay' + (rep.description ? ' — ' + esc(rep.description) : '') + '</div>'
      : rep.expression
      ? '<div style="font-size:12px;color:var(--m);font-family:ui-monospace,Menlo,monospace;margin-top:4px">' + esc(rep.expression) + ' ' + esc(rep.comparatorOp) + ' ' + esc(rep.threshold) + '</div>'
      : '<div style="font-size:12px;color:var(--m);margin-top:4px">No check configured</div>';

    const rows = (rep.runs || []).map(r => {
      const badge = r.passed
        ? '<span style="color:var(--green);font-weight:600">● PASS</span>'
        : '<span style="color:var(--red);font-weight:600">● FAIL</span>';
      const when = new Date(r.timestamp).toLocaleString();
      let detail = '<span style="color:var(--m)">observed</span> ' + esc(r.observed);
      if (r.error) detail += ' · <span style="color:var(--red)">' + esc(r.error) + '</span>';
      if (r.captures && Object.keys(r.captures).length) {
        const caps = Object.entries(r.captures).map(kv => {
          const v = String(kv[1]);
          const shown = v.length > 80 ? v.slice(0, 80) + '…' : v; // full value lives in the drill-in
          return esc(kv[0]) + '=' + esc(shown);
        }).join(', ');
        detail += ' · <span style="color:var(--m)">' + caps + '</span>';
      }
      // Drill in whenever there's something fuller to show: failed runs carry
      // request/response detail, and any run with captures has untruncated values.
      const hasCaps = r.captures && Object.keys(r.captures).length > 0;
      const clickable = r.runId && (r.hasDetail || hasCaps);
      if (clickable) detail += ' · <span style="color:var(--y)">🔍 details</span>';
      const dataAttrs = clickable
        ? ' data-run-detail="1" data-monitorid="' + esc(rep.monitorId) + '" data-timestamp="' + esc(r.timestamp) + '" data-runid="' + esc(r.runId) + '"'
        : '';
      const cls = clickable ? 'report-row report-row-clickable' : 'report-row';
      return '<div class="' + cls + '"' + dataAttrs + ' style="display:flex;gap:12px;align-items:baseline;padding:6px 0;border-top:1px solid #1d1d1d;font-size:13px">'
        + '<span style="white-space:nowrap;min-width:160px;color:var(--m)">' + esc(when) + '</span>'
        + '<span style="white-space:nowrap;min-width:64px">' + badge + '</span>'
        + '<span style="flex:1">' + detail + '</span>'
        + '</div>';
    }).join('');

    const body = total
      ? '<div style="max-height:320px;overflow:auto;margin-top:10px">' + rows + '</div>'
        + (rep.capped ? '<div style="font-size:11px;color:var(--m);margin-top:8px">Showing the most recent 500 runs in this window.</div>' : '')
      : '';

    // Shared chrome for both corrupt-row banners — only the modifier class and
    // inner content differ between the exact (purgeable) and legacy cases.
    const banner = (extraClass, inner) => '<div class="corrupt-banner' + extraClass + '">' + inner + '</div>';
    const corruptBanner = (rep.corrupt || []).map(c => {
      if (c.exact) {
        // Exact key recovered from the index → one-click purge.
        const when = new Date(c.timestamp).toLocaleString();
        return banner('',
          '<span>⚠️ An unreadable run row is blocking older history (saved ' + esc(when) + ', run ' + esc(String(c.runId).slice(0, 8)) + '…).</span>'
          + '<button class="btn btn-danger btn-sm" data-purge-run="1"'
          + ' data-monitorid="' + esc(rep.monitorId) + '" data-timestamp="' + esc(c.timestamp) + '" data-runid="' + esc(c.runId) + '">Purge row</button>');
      }
      // Legacy orphan: no index entry, so we only know the timestamp bracket.
      // User pastes the runId (from deploy logs in that window) to purge it.
      const bracket = c.olderThan
        ? 'between ' + esc(new Date(c.olderThan).toLocaleString()) + ' and ' + (c.newerThan ? esc(new Date(c.newerThan).toLocaleString()) : 'now')
        : (c.newerThan ? 'just before ' + esc(new Date(c.newerThan).toLocaleString()) : 'in this monitor');
      return banner(' corrupt-banner-legacy',
        '<div>⚠️ A legacy unreadable run row (' + bracket + ') is blocking older history. '
        + 'Find its <code>runId</code> + <code>timestamp</code> in the deploy logs (a <code>cron.persist: saved runId=…</code> line in that window), then purge it:</div>'
        + '<form class="corrupt-purge-form" data-purge-legacy="1" data-monitorid="' + esc(rep.monitorId) + '">'
        + '<input type="text" name="timestamp" placeholder="2026-06-09T09:30:45.910Z" required>'
        + '<input type="text" name="runid" placeholder="runId (UUID)" required>'
        + '<button type="submit" class="btn btn-danger btn-sm">Purge row</button>'
        + '</form>'
        + '<div class="corrupt-dismiss">Cannot track it down? It cannot be deleted (its key is unrecoverable), but you can '
        + '<button class="btn btn-ghost btn-sm" data-dismiss-corrupt="1" data-monitorid="' + esc(rep.monitorId) + '">Dismiss warning</button></div>');
    }).join('');

    return '<div class="card" style="margin-bottom:16px">'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">'
      + '<div><h3 style="margin:0;font-size:15px">' + esc(rep.name) + '</h3>' + ctx + '</div>'
      + '<div style="font-size:13px;text-align:right">' + summary + '</div>'
      + '</div>'
      + corruptBanner
      + body
      + '</div>';
  }).join('');
}

// ─── Purge a corrupt run row ────────────────────────────────────────────────────
async function purgeRun(monitorId, timestamp, runId, btn) {
  if (!timestamp || !runId) { alert('Both a timestamp and a runId are required.'); return; }
  if (!confirm('Permanently delete this run row?\\n\\ntimestamp: ' + timestamp + '\\nrunId: ' + runId + '\\n\\nThis cannot be undone.')) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Purging…'; }
  try {
    await api('DELETE', '/api/runs/'
      + encodeURIComponent(monitorId) + '/'
      + encodeURIComponent(timestamp) + '/'
      + encodeURIComponent(runId));
    console.log('🗑️ purgeRun: deleted run ' + runId + ' — reloading reports');
    loadReports(); // re-scan; older rows behind the purged orphan now load
  } catch (e) {
    console.error('❌ purgeRun failed:', e.message);
    alert('Could not purge run: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Purge row'; }
  }
}

// Dismiss the legacy "unreadable row" banner for a monitor. The row can't be
// deleted (its key is unrecoverable), so this just records an acknowledgement so
// the warning stops showing. Genuinely purgeable (indexed) rows are unaffected.
async function dismissCorrupt(monitorId, btn) {
  if (!confirm('Hide this unreadable-row warning for this monitor?\\n\\nThe row cannot be deleted (its key is unrecoverable), so this only stops the warning from showing. A newly corrupt row would still appear.')) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Dismissing…'; }
  try {
    await api('POST', '/api/reports/' + encodeURIComponent(monitorId) + '/dismiss-corrupt');
    console.log('🙈 dismissCorrupt: dismissed for ' + monitorId + ' — reloading reports');
    loadReports();
  } catch (e) {
    console.error('❌ dismissCorrupt failed:', e.message);
    alert('Could not dismiss warning: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Dismiss warning'; }
  }
}

// ─── Run detail drill-in ───────────────────────────────────────────────────────
async function openRunDetail(monitorId, timestamp, runId) {
  const modal = document.getElementById('run-detail-modal');
  const body = document.getElementById('run-detail-body');
  const copyAll = document.getElementById('run-detail-copy-all');
  _runDetailCopy = null;
  if (copyAll) copyAll.style.display = 'none';
  body.innerHTML = '<div class="empty-state"><div style="font-size:32px">📊</div><p>Loading…</p></div>';
  modal.classList.add('open');
  try {
    const run = await api('GET', '/api/runs/'
      + encodeURIComponent(monitorId) + '/'
      + encodeURIComponent(timestamp) + '/'
      + encodeURIComponent(runId));
    body.innerHTML = renderRunDetail(run);
    if (copyAll) copyAll.style.display = '';
  } catch (e) {
    body.innerHTML = '<div class="empty-state"><div style="font-size:32px">⚠️</div><p>Could not load run: ' + esc(e.message) + '</p></div>';
  }
}

function closeRunDetail() {
  document.getElementById('run-detail-modal').classList.remove('open');
  const copyAll = document.getElementById('run-detail-copy-all');
  if (copyAll) copyAll.style.display = 'none';
}

function copyRunPart(key, btn) {
  const text = _runDetailCopy && _runDetailCopy[key];
  if (!text) return;
  navigator.clipboard.writeText(text).then(
    () => {
      if (!btn) return;
      const prev = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = prev; }, 1400);
    },
    () => alert('Could not copy — select the text manually'),
  );
}

var _runDetailCopy = null;

function renderRunDetail(run) {
  const sectionTitle = (t, copyKey) => '<div style="display:flex;align-items:center;justify-content:space-between;margin:18px 0 8px">'
    + '<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--m);margin:0">' + esc(t) + '</h3>'
    + (copyKey ? '<button class="btn btn-ghost btn-sm" type="button" data-copy="' + copyKey + '">Copy</button>' : '')
    + '</div>';
  const pre = s => '<pre style="background:#0d0d0d;border:1px solid var(--b);border-radius:8px;padding:12px;overflow:auto;font-size:12px;max-height:300px;white-space:pre-wrap;word-break:break-word;margin:0">' + s + '</pre>';

  const status = run.passed
    ? '<span style="color:var(--green);font-weight:600">● PASS</span>'
    : '<span style="color:var(--red);font-weight:600">● FAIL</span>';
  let html = '<div style="font-size:13px;margin-bottom:6px">'
    + '<span style="color:var(--m)">' + esc(new Date(run.timestamp).toLocaleString()) + '</span> · '
    + status + ' · <span style="color:var(--m)">observed</span> ' + esc(run.observed) + '</div>';
  if (run.error) html += '<div style="font-size:13px;color:var(--red);margin-bottom:8px">' + esc(run.error) + '</div>';

  // Plain-text payloads mirroring what's displayed, for the copy buttons.
  let reqText = '', resText = '', capText = '';

  // Captures — the named values pulled from the response on EVERY run (pass or
  // fail). The Reports row truncates each to 80 chars; here we show them in full,
  // pretty-printing any value that parses as JSON (e.g. an errors=[…] array).
  const caps = run.captures;
  if (caps && Object.keys(caps).length) {
    const capLines = [];
    let capBlock = '';
    for (const [k, raw] of Object.entries(caps)) {
      const v = String(raw);
      let shown = v, ok = true;
      try { shown = JSON.stringify(JSON.parse(v), null, 2); } catch (_) { ok = false; }
      capLines.push(k + '=' + (ok ? shown : v));
      capBlock += '<div style="font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--y);margin:8px 0 4px;word-break:break-all">' + esc(k) + '</div>'
        + pre(esc(ok ? shown : v));
    }
    capText = capLines.join('\\n\\n');
    html += sectionTitle('Captures', 'captures');
    html += capBlock;
  }

  const req = run.request;
  if (req) {
    const reqLines = [req.method + ' ' + req.url];
    if (req.headers && Object.keys(req.headers).length) {
      reqLines.push('', Object.entries(req.headers).map(h => h[0] + ': ' + h[1]).join('\\n'));
    }
    if (req.body) reqLines.push('', req.body);
    reqText = reqLines.join('\\n');

    html += sectionTitle('Request', 'request');
    html += '<div style="font-family:ui-monospace,Menlo,monospace;font-size:12px;margin-bottom:6px;word-break:break-all">'
      + '<span style="color:var(--y)">' + esc(req.method) + '</span> ' + esc(req.url) + '</div>';
    if (req.headers && Object.keys(req.headers).length) {
      html += pre(Object.entries(req.headers).map(h => esc(h[0]) + ': ' + esc(h[1])).join('\\n'));
    }
    if (req.body) html += '<div style="margin-top:6px">' + pre(esc(req.body)) + '</div>';
  }

  const res = run.response;
  if (res) {
    const statusStr = (res.status !== undefined && res.status !== null) ? ' · ' + res.status : '';
    let bodyText = '';
    if (res.body !== undefined && res.body !== null && res.body !== '') {
      let parsed = null, ok = true;
      try { parsed = JSON.parse(res.body); } catch (_) { ok = false; }
      bodyText = ok ? JSON.stringify(parsed, null, 2) : res.body;
    }
    const resHead = (res.status !== undefined && res.status !== null) ? String(res.status) : '';
    resText = [resHead, bodyText].filter(Boolean).join('\\n\\n');

    html += sectionTitle('Response' + statusStr, bodyText ? 'response' : null);
    if (bodyText) {
      html += pre(esc(bodyText));
    } else {
      html += '<p style="font-size:12px;color:var(--m)">No response body captured.</p>';
    }
    if (res.truncated) html += '<div style="font-size:11px;color:var(--m);margin-top:6px">Response body was truncated to keep history small.</div>';
  }

  if (!req && !res && !capText) html += '<p style="font-size:13px;color:var(--m)">No request/response detail was captured for this run.</p>';

  // "Copy all" payload — same pieces, one block.
  const metaLine = new Date(run.timestamp).toLocaleString() + ' · ' + (run.passed ? 'PASS' : 'FAIL') + ' · observed ' + run.observed;
  const allParts = ['Run detail — ' + metaLine];
  if (run.error) allParts.push('Error: ' + run.error);
  if (capText) allParts.push('', '=== CAPTURES ===', capText);
  if (reqText) allParts.push('', '=== REQUEST ===', reqText);
  if (resText) allParts.push('', '=== RESPONSE ===', resText);
  _runDetailCopy = { request: reqText, response: resText, captures: capText, all: allParts.join('\\n') };

  return html;
}

async function runNow(monitorId, btn) {
  btn.disabled = true; btn.textContent = 'Running...';
  try {
    await api('POST', '/run/' + monitorId);
    btn.textContent = 'Done!';
    setTimeout(() => { btn.disabled = false; btn.textContent = 'Run now'; }, 2000);
  } catch (e) {
    btn.textContent = 'Failed';
    setTimeout(() => { btn.disabled = false; btn.textContent = 'Run now'; }, 2000);
  }
}

// ─── Wizard ──────────────────────────────────────────────────────────────────
function startWizard() {
  S.wizardMonitorId = null;
  S.wizardMode = 'create';
  resetWizard();
  wizardGoStep(1);
  showView('wizard');
  document.getElementById('wiz-title').textContent = 'Add monitor';
  document.getElementById('wiz-subtitle').textContent = '';
}

function editCheck(monitorId) {
  S.wizardMonitorId = monitorId;
  S.wizardMode = 'edit-check';
  resetWizard();
  wizardGoStep(2);
  showView('wizard');
  document.getElementById('wiz-title').textContent = 'Edit check';
  document.getElementById('wiz-subtitle').textContent = monitorId;
  document.getElementById('ws2-btn').textContent = 'Save check';
  prefillCheck(monitorId);
}

function editAlert(monitorId) {
  S.wizardMonitorId = monitorId;
  S.wizardMode = 'edit-alert';
  resetWizard();
  wizardGoStep(3);
  showView('wizard');
  document.getElementById('wiz-title').textContent = 'Edit alert';
  document.getElementById('wiz-subtitle').textContent = monitorId;
  document.getElementById('ws3-btn').textContent = 'Save alert';
  prefillAlert(monitorId);
}

async function editDetails(monitorId) {
  S.wizardMonitorId = monitorId;
  S.wizardMode = 'edit-details';
  resetWizard();
  wizardGoStep(1);
  showView('wizard');
  document.getElementById('wiz-title').textContent = 'Edit details';
  document.getElementById('wiz-subtitle').textContent = monitorId;
  document.getElementById('ws1-btn').textContent = 'Save details';
  try {
    const m = await api('GET', '/monitors/' + monitorId);
    document.getElementById('w-name').value = m.name || '';
    document.getElementById('w-desc').value = m.description || '';
  } catch (e) {
    document.getElementById('ws1-err').textContent = e.message;
  }
}

// Duplicate: open the create wizard prefilled with a full copy of the source's
// check + alert config. Nothing is persisted until the user finishes the steps —
// create mode (wizardMonitorId=null) makes wizardStep1 POST a brand-new monitor.
async function duplicateMonitor(sourceId) {
  S.wizardMonitorId = null;
  S.wizardMode = 'create';
  resetWizard();
  document.getElementById('wiz-title').textContent = 'Duplicate monitor';
  document.getElementById('wiz-subtitle').textContent = '';
  wizardGoStep(1);
  showView('wizard');
  try {
    const m = await api('GET', '/monitors/' + sourceId);
    document.getElementById('w-name').value = '(Copy of) ' + (m.name || '');
    document.getElementById('w-desc').value = m.description || '';
    // prefillCheck/prefillAlert fill steps 2 & 3 by element id from the source —
    // they don't touch S.wizardMonitorId, so they're safe in create mode.
    await prefillCheck(sourceId);
    await prefillAlert(sourceId);
  } catch (e) {
    document.getElementById('ws1-err').textContent = e.message;
  }
  // Focus the name with the caret at the very start of the box.
  const nameEl = document.getElementById('w-name');
  nameEl.focus();
  if (nameEl.setSelectionRange) nameEl.setSelectionRange(0, 0);
}

function resetWizard() {
  document.getElementById('w-name').value = '';
  document.getElementById('w-desc').value = '';
  document.getElementById('w-url').value = '';
  document.getElementById('w-method').value = 'GET';
  document.getElementById('w-expr').value = '';
  document.getElementById('w-op').value = 'gt';
  document.getElementById('w-threshold').value = '';
  document.getElementById('w-recover').checked = false;
  document.getElementById('w-notify-success').checked = false;
  document.getElementById('w-logs-url').value = '';
  document.getElementById('w-cron').value = '';
  document.getElementById('w-time').value = '09:00'; // default selection
  document.getElementById('w-freq').value = 'daily';
  document.getElementById('w-days').value = 'daily';
  document.getElementById('w-body').value = '';
  document.getElementById('w-report-only').checked = false;
  toggleReportMode();
  document.getElementById('headers-list').innerHTML = '';
  document.getElementById('captures-list').innerHTML = '';
  document.getElementById('w-email-addr').value = '';
  document.getElementById('w-sms-list').innerHTML = '';
  addSmsRow(); // always show one empty SMS row to start
  document.getElementById('w-ntfy-addr').value = '';
  document.getElementById('w-email-subject').value = '';
  document.getElementById('w-email-message').value = '';
  document.getElementById('w-sms-message').value = '';
  document.getElementById('w-ntfy-title').value = '';
  document.getElementById('w-ntfy-message').value = '';
  ws3Tab('config');
  document.getElementById('ws1-btn').textContent = 'Next: Check config';
  const ws2btn = document.getElementById('ws2-btn');
  ws2btn.disabled = false; ws2btn.textContent = 'Next: Alert config';
  document.getElementById('ws3-btn').textContent = 'Save monitor';
  document.getElementById('test-result').style.display = 'none';
  document.getElementById('test-error').style.display = 'none';
  // Clear any show-once webhook secret from a previous monitor so it can't leak
  // into a different monitor's Webhook tab (panel/example curl/clipboard).
  _lastWebhookSecret = null;
  _extraRecipients = [];
  const whSecretPre = document.getElementById('wh-secret-pre');
  if (whSecretPre) whSecretPre.textContent = '';
  const whSecretDisplay = document.getElementById('wh-secret-display');
  if (whSecretDisplay) whSecretDisplay.style.display = 'none';
  setSchedMode('simple');
  updateBodyVisibility();
  clearErr();
  updateSimpleSched();
}

function wizardBack() {
  const step = currentStep();
  if (step === 1 || S.wizardMode !== 'create') {
    showView('dashboard');
  } else {
    wizardGoStep(step - 1);
  }
}

function currentStep() {
  for (let i = 1; i <= 3; i++) {
    if (document.getElementById('ws' + i).style.display !== 'none') return i;
  }
  return 1;
}

function wizardGoStep(n) {
  for (let i = 1; i <= 3; i++) {
    document.getElementById('ws' + i).style.display = i === n ? 'block' : 'none';
    const s = document.getElementById('wstep-' + i);
    s.className = 'step' + (i === n ? ' active' : i < n ? ' done' : '');
  }
  if (n === 2) updateSimpleSched();
}

async function wizardStep1() {
  const name = document.getElementById('w-name').value.trim();
  const description = document.getElementById('w-desc').value.trim();
  if (!name) { document.getElementById('ws1-err').textContent = 'Monitor name is required.'; return; }
  clearErr();
  // Edit-details mode: PATCH the existing monitor's name/description, then
  // return to the dashboard (no check/alert steps).
  if (S.wizardMode === 'edit-details') {
    try {
      await api('PATCH', '/monitors/' + S.wizardMonitorId, { name, description });
      showView('dashboard');
    } catch (e) {
      document.getElementById('ws1-err').textContent = e.message;
    }
    return;
  }
  // Only create a monitor in create mode — never re-POST while editing an
  // existing one (would orphan the edit onto a brand-new monitor).
  if (S.wizardMode !== 'create') { wizardGoStep(2); return; }
  try {
    const data = await api('POST', '/monitors', { name, description });
    S.wizardMonitorId = data.monitorId;
    wizardGoStep(2);
  } catch (e) {
    document.getElementById('ws1-err').textContent = e.message;
  }
}

async function wizardStep2() {
  const url = document.getElementById('w-url').value.trim();
  const reportOnly = document.getElementById('w-report-only').checked;
  const expression = document.getElementById('w-expr').value.trim();
  const threshold = parseFloat(document.getElementById('w-threshold').value);
  if (!url) { document.getElementById('ws2-err').textContent = 'URL is required.'; return; }
  // Report mode has no comparator — skip the expression/threshold requirements.
  if (!reportOnly) {
    if (!expression) { document.getElementById('ws2-err').textContent = 'JSON expression is required.'; return; }
    if (isNaN(threshold)) { document.getElementById('ws2-err').textContent = 'Threshold must be a number.'; return; }
  }

  let cron = '';
  if (S.schedMode === 'cron') {
    cron = document.getElementById('w-cron').value.trim();
    if (!cron) { document.getElementById('ws2-err').textContent = 'Cron expression is required.'; return; }
  } else {
    cron = buildLocalCron(
      document.getElementById('w-freq').value,
      document.getElementById('w-time').value,
      document.getElementById('w-days').value,
    );
  }

  const headers = {};
  document.querySelectorAll('#headers-list .header-row').forEach(row => {
    const [k, v] = row.querySelectorAll('input');
    if (k.value.trim()) headers[k.value.trim()] = v.value.trim();
  });

  const captures = {};
  document.querySelectorAll('#captures-list .header-row').forEach(row => {
    const [name, path] = row.querySelectorAll('input');
    if (name.value.trim() && path.value.trim()) captures[name.value.trim()] = path.value.trim();
  });

  clearErr();
  console.log('🚀 wizardStep2: saving check monitorId=' + S.wizardMonitorId + ' schedMode=' + S.schedMode + ' cron=' + cron);
  try {
    const bodyVal = document.getElementById('w-body').value.trim();
    const payload = {
      url,
      method: document.getElementById('w-method').value,
      headers,
      body: bodyVal || undefined,
      expression,
      comparatorOp: document.getElementById('w-op').value,
      threshold: reportOnly && isNaN(threshold) ? 0 : threshold,
      cron,
      reportOnly: reportOnly || undefined,
      notifyOnRecover: document.getElementById('w-recover').checked,
      notifyOnSuccess: document.getElementById('w-notify-success').checked,
      logsUrl: document.getElementById('w-logs-url').value.trim() || undefined,
      captures: Object.keys(captures).length ? captures : undefined,
    };
    console.log('🔍 wizardStep2: POST payload', JSON.stringify(payload));
    const result = await api('POST', '/monitors/' + S.wizardMonitorId + '/check', payload);
    console.log('✅ wizardStep2: check saved', JSON.stringify(result));
    // Edit-check is a standalone edit: the check is now saved, so finish here
    // instead of forcing the Alerts step (a check needs no alert — see the
    // runner's graceful no-alert handling). Create mode still walks to Step 3.
    if (S.wizardMode === 'edit-check') {
      const b = document.getElementById('ws2-btn');
      b.disabled = true; b.textContent = 'Check saved!';
      setTimeout(() => showView('dashboard'), 900);
      return;
    }
    wizardGoStep(3);
  } catch (e) {
    document.getElementById('ws2-err').textContent = e.message;
  }
}

async function wizardStep3() {
  const emailAddr = document.getElementById('w-email-addr').value.trim();
  const smsAddrs = [...document.querySelectorAll('#w-sms-list input')]
    .map(i => i.value.trim()).filter(Boolean);
  const ntfyAddr = document.getElementById('w-ntfy-addr').value.trim();
  const emailSubject = document.getElementById('w-email-subject').value.trim() || undefined;
  const emailMessage = document.getElementById('w-email-message').value.trim() || undefined;
  const smsMessage = document.getElementById('w-sms-message').value.trim() || undefined;
  const ntfyTitle = document.getElementById('w-ntfy-title').value.trim() || undefined;
  const ntfyMessage = document.getElementById('w-ntfy-message').value.trim() || undefined;

  const showErr = (msg) => {
    const el = document.getElementById('ws3-err');
    el.textContent = msg;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  if (!emailAddr && smsAddrs.length === 0 && !ntfyAddr) {
    showErr('Add at least one email, phone number, or ntfy topic.');
    return;
  }
  if (emailAddr && !emailAddr.includes('@')) {
    showErr('Email address must contain @.');
    return;
  }
  for (const n of smsAddrs) {
    // NB: this runs inside the INDEX_HTML template literal, so a "\d"/"\D" escape
    // would be silently stripped to "d"/"D" at runtime. Use [^0-9] (no backslash)
    // to strip non-digits reliably — otherwise formatted numbers (+, spaces,
    // dashes) fail the length check and a saved alert can't be re-saved.
    const digits = n.replace(/[^0-9]/g, '');
    if (digits.length < 10 || digits.length > 11) {
      showErr('Each phone number must be 10 or 11 digits (e.g. 18432222986).');
      return;
    }
  }
  if (ntfyAddr) {
    // Light client-side guard; the server does the authoritative check. Uses
    // plain string ops, not regex — backslash escapes get mangled inside the
    // INDEX_HTML template literal.
    const lower = ntfyAddr.toLowerCase();
    let topic = lower.startsWith('https://') ? ntfyAddr.slice(8)
              : lower.startsWith('http://') ? ntfyAddr.slice(7)
              : ntfyAddr;
    while (topic.startsWith('/')) topic = topic.slice(1);
    while (topic.endsWith('/')) topic = topic.slice(0, -1);
    if (!topic || ntfyAddr.indexOf(' ') !== -1) {
      showErr('ntfy topic looks invalid — use a topic name (e.g. my-alerts) or a full ntfy URL.');
      return;
    }
  }

  const recipients = [];
  if (emailAddr) recipients.push({ channel: 'email', address: emailAddr });
  smsAddrs.forEach(a => recipients.push({ channel: 'sms', address: a }));
  if (ntfyAddr) recipients.push({ channel: 'ntfy', address: ntfyAddr });
  // Re-append any email/ntfy recipients the single-field UI can't represent so
  // the full-replace save doesn't drop them (see prefillAlert / _extraRecipients).
  if (_extraRecipients && _extraRecipients.length) recipients.push(..._extraRecipients);

  const btn = document.getElementById('ws3-btn');
  const isEditAlert = S.wizardMode === 'edit-alert';
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Saving...';
  clearErr();
  console.log('🚀 wizardStep3: saving alert monitorId=' + S.wizardMonitorId + ' recipients=' + JSON.stringify(recipients));
  try {
    const result = await api('POST', '/monitors/' + S.wizardMonitorId + '/alert', { recipients, emailSubject, emailMessage, smsMessage, ntfyTitle, ntfyMessage });
    console.log('✅ wizardStep3: alert saved', JSON.stringify(result));
    document.getElementById('ws3-ok').textContent = isEditAlert ? 'Alert saved!' : 'Monitor saved!';
    setTimeout(() => { console.log('🔍 wizardStep3: navigating to dashboard'); showView('dashboard'); }, 1200);
  } catch (e) {
    console.error('❌ wizardStep3: error', e.message);
    showErr(e.message);
    btn.disabled = false; btn.textContent = isEditAlert ? 'Save alert' : 'Save monitor';
  }
}

// ─── Prefill for edit mode ────────────────────────────────────────────────────
// Email/ntfy recipients beyond the single field the wizard exposes, stashed on
// prefill and re-appended on save so editing an alert doesn't drop them.
let _extraRecipients = [];

function parseUtcCronToSimple(cron) {
  if (!cron) return null;
  if (cron === '0 * * * *') return { freq: 'hourly', timeValue: '09:00', days: 'daily' };
  const parts = cron.split(' ');
  if (parts.length !== 5) return null;
  const [mm, hh, dom, month, dow] = parts;
  if (dom !== '*' || month !== '*') return null;
  const utcMm = parseInt(mm, 10);
  const utcHh = parseInt(hh, 10);
  if (isNaN(utcMm) || isNaN(utcHh)) return null;
  // Convert UTC back to local
  const offsetMin = new Date().getTimezoneOffset();
  const localTotalMin = utcHh * 60 + utcMm - offsetMin;
  const localHh = ((Math.floor(localTotalMin / 60)) % 24 + 24) % 24;
  const localMm = ((localTotalMin % 60) + 60) % 60;
  // The Simple-tab time dropdown only has 10-minute increments. A cron whose
  // local minute isn't a 10-min boundary (e.g. "5 9 * * *", or any :45-offset
  // zone round-trip) has no matching <option>, so setting w-time.value would
  // silently no-op and a subsequent save would rewrite the cron to :00. Fall
  // back to the Cron tab (returns null) so the exact expression is shown/kept.
  if (localMm % 10 !== 0) return null;
  const timeValue = String(localHh).padStart(2,'0') + ':' + String(localMm).padStart(2,'0');
  let days = 'daily';
  if (dow === '1-5') days = 'weekdays';
  else if (dow === '0,6') days = 'weekends';
  else if (dow !== '*') return null;
  return { freq: 'daily', timeValue, days };
}

async function prefillCheck(monitorId) {
  console.log('🔍 prefillCheck: loading monitorId=' + monitorId);
  try {
    const d = await api('GET', '/monitors/' + monitorId + '/check');
    console.log('✅ prefillCheck: got check', JSON.stringify(d));
    document.getElementById('w-url').value = d.url || '';
    document.getElementById('w-method').value = d.method || 'GET';
    document.getElementById('w-body').value = d.body || '';
    document.getElementById('w-expr').value = d.expression || '';
    document.getElementById('w-op').value = d.comparatorOp || 'gt';
    document.getElementById('w-threshold').value = d.threshold ?? '';
    document.getElementById('w-recover').checked = !!d.notifyOnRecover;
    document.getElementById('w-notify-success').checked = !!d.notifyOnSuccess;
    document.getElementById('w-report-only').checked = !!d.reportOnly;
    toggleReportMode();
    document.getElementById('w-logs-url').value = d.logsUrl || '';
    updateBodyVisibility();
    updateComparatorHint();
    if (d.headers) {
      Object.entries(d.headers).forEach(([k, v]) => addHeaderRow(k, v));
    }
    if (d.captures) {
      Object.entries(d.captures).forEach(([name, path]) => addCaptureRow(name, path));
    }
    const simple = parseUtcCronToSimple(d.cron);
    console.log('🔍 prefillCheck: cron=' + d.cron + ' → simple=' + JSON.stringify(simple));
    if (simple) {
      setSchedMode('simple');
      document.getElementById('w-freq').value = simple.freq;
      document.getElementById('w-time').value = simple.timeValue;
      document.getElementById('w-days').value = simple.days;
      updateSimpleSched();
    } else if (d.cron) {
      setSchedMode('cron');
      document.getElementById('w-cron').value = d.cron;
    }
  } catch (e) {
    console.error('❌ prefillCheck: error', e.message);
  }
}

async function prefillAlert(monitorId) {
  _extraRecipients = [];
  try {
    const d = await api('GET', '/monitors/' + monitorId + '/alert');
    const list = d.recipients || [];
    const emailRec = list.find(r => r.channel === 'email');
    const ntfyRec = list.find(r => r.channel === 'ntfy');
    const smsRecs = list.filter(r => r.channel === 'sms');
    // The wizard exposes only ONE email and ONE ntfy field, and at most 5 SMS
    // rows, but the schema/API permit more. Stash any recipient the UI can't
    // render so the full-replace POST doesn't silently drop it (wizardStep3
    // re-adds _extraRecipients on save). The SMS list is capped at 5 rows by
    // addSmsRow, so anything past the 5th must be stashed too — otherwise a 6th
    // on-call number is permanently lost the first time the alert is edited.
    const MAX_SMS_ROWS = 5;
    _extraRecipients = [
      ...list.filter(r =>
        (r.channel === 'email' && r !== emailRec) ||
        (r.channel === 'ntfy' && r !== ntfyRec)
      ),
      ...smsRecs.slice(MAX_SMS_ROWS),
    ];
    if (emailRec) document.getElementById('w-email-addr').value = emailRec.address;
    document.getElementById('w-sms-list').innerHTML = '';
    smsRecs.slice(0, MAX_SMS_ROWS).forEach(r => addSmsRow(r.address));
    if (!document.getElementById('w-sms-list').children.length) addSmsRow();
    if (ntfyRec) document.getElementById('w-ntfy-addr').value = ntfyRec.address;
    if (d.emailSubject) document.getElementById('w-email-subject').value = d.emailSubject;
    if (d.emailMessage) document.getElementById('w-email-message').value = d.emailMessage;
    if (d.smsMessage) document.getElementById('w-sms-message').value = d.smsMessage;
    if (d.ntfyTitle) document.getElementById('w-ntfy-title').value = d.ntfyTitle;
    if (d.ntfyMessage) document.getElementById('w-ntfy-message').value = d.ntfyMessage;
  } catch (e) {
    // 404 = no alert configured yet, not an error worth showing
    if (!e.message || (!e.message.includes('not found') && !e.message.includes('not-found') && !e.message.includes('404'))) {
      document.getElementById('ws3-err').textContent = 'Could not load existing alert: ' + e.message;
    }
  }
}

// ─── Headers builder ──────────────────────────────────────────────────────────
function addHeaderRow(k = '', v = '') {
  const row = document.createElement('div');
  row.className = 'header-row';
  row.innerHTML = \`
    <input type="text" placeholder="Header name" value="\${esc(k)}">
    <input type="text" placeholder="Value" value="\${esc(v)}">
    <button class="icon-btn" onclick="this.parentElement.remove()" title="Remove">&#x2715;</button>
  \`;
  document.getElementById('headers-list').appendChild(row);
}

// ─── Captures builder ─────────────────────────────────────────────────────────
function addCaptureRow(name = '', path = '') {
  const row = document.createElement('div');
  row.className = 'header-row';
  row.innerHTML = \`
    <input type="text" placeholder="variable name (e.g. callsLeft)" value="\${esc(name)}">
    <input type="text" placeholder="json path (e.g. data.remaining)" value="\${esc(path)}">
    <button class="icon-btn" onclick="this.parentElement.remove()" title="Remove">&#x2715;</button>
  \`;
  document.getElementById('captures-list').appendChild(row);
}

// ─── SMS numbers builder ──────────────────────────────────────────────────────
function addSmsRow(value = '') {
  const list = document.getElementById('w-sms-list');
  if (list.children.length >= 5) return;
  const row = document.createElement('div');
  row.className = 'sms-row';
  row.innerHTML = \`
    <input type="text" placeholder="18432222986" value="\${esc(value)}">
    <button class="icon-btn" onclick="this.parentElement.remove(); updateSmsAddBtn()" title="Remove">&#x2715;</button>
  \`;
  list.appendChild(row);
  updateSmsAddBtn();
}

function updateSmsAddBtn() {
  const count = document.getElementById('w-sms-list').children.length;
  document.getElementById('w-sms-add-btn').style.display = count >= 5 ? 'none' : 'inline-flex';
}


// ─── Schedule ─────────────────────────────────────────────────────────────────
function setSchedMode(mode) {
  S.schedMode = mode;
  document.getElementById('sched-simple').style.display = mode === 'simple' ? 'block' : 'none';
  document.getElementById('sched-cron').style.display = mode === 'cron' ? 'block' : 'none';
  document.getElementById('sched-simple-tab').className = 'sched-tab' + (mode === 'simple' ? ' active' : '');
  document.getElementById('sched-cron-tab').className = 'sched-tab' + (mode === 'cron' ? ' active' : '');
}

function buildLocalCron(freq, timeValue, days) {
  if (freq === 'hourly') return '0 * * * *';
  const [hh, mm] = timeValue.split(':').map(Number);
  // Convert local time to UTC (cron runs in UTC on Deno Deploy).
  // NB: this uses the offset *now*, baked into a static UTC cron — so a fixed
  // local time drifts by ±1h across a DST transition. Acceptable for a monitor;
  // true DST-aware scheduling would require storing the zone and recomputing.
  const offsetMin = new Date().getTimezoneOffset(); // minutes west of UTC
  const totalMin = hh * 60 + mm + offsetMin;
  const utcHh = ((Math.floor(totalMin / 60)) % 24 + 24) % 24;
  const utcMm = ((totalMin % 60) + 60) % 60;
  // The local→UTC conversion can cross a day boundary; when it does, a
  // day-restricted schedule (weekdays/weekends) must shift its weekday set by
  // the same number of days, or e.g. a Sunday-night 'weekends' run rolls into
  // Monday UTC and never fires. dayDelta is -1, 0, or +1.
  const dayDelta = Math.floor(totalMin / 1440);
  const shiftDays = (set) => set.map((d) => ((d + dayDelta) % 7 + 7) % 7).sort((a, b) => a - b).join(',');
  let dayField = '*';
  if (days === 'weekdays') dayField = dayDelta === 0 ? '1-5' : shiftDays([1, 2, 3, 4, 5]);
  else if (days === 'weekends') dayField = dayDelta === 0 ? '0,6' : shiftDays([0, 6]);
  return \`\${utcMm} \${utcHh} * * \${dayField}\`;
}

function buildTimeOptions() {
  const sel = document.getElementById('w-time');
  const opts = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 10) {
      const ampm = h < 12 ? 'AM' : 'PM';
      const h12 = h % 12 || 12;
      const label = h12 + ':' + String(m).padStart(2,'0') + ' ' + ampm;
      const val = String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
      opts.push('<option value="' + val + '"' + (val === '09:00' ? ' selected' : '') + '>' + label + '</option>');
    }
  }
  sel.innerHTML = opts.join('');
}

function updateComparatorHint() {
  const op = document.getElementById('w-op').value;
  const threshold = document.getElementById('w-threshold').value;
  // esc() the expression: it is server-persisted, attacker-controllable input
  // (configureCheck only requires a non-empty string), and it is interpolated
  // into innerHTML below. Without escaping, a stored value like
  // "<img src=x onerror=...>" executes in the viewer's session when they open
  // "Edit check" — every other innerHTML sink in the SPA is esc()'d.
  const expr = esc(document.getElementById('w-expr').value.trim() || 'value');
  const el = document.getElementById('comparator-hint');
  if (!threshold) { el.style.display = 'none'; return; }
  const t = parseFloat(threshold);
  const opLabels = { gt: '>', lt: '<', gte: '>=', lte: '<=', eq: '=' };
  const sym = opLabels[op];
  // Alert fires when check FAILS — check passes when condition is true
  // So we need the INVERSE condition for when alert fires
  const inverseLabel = { gt: '<=', lt: '>=', gte: '<', lte: '>', eq: '!=' }[op];
  const exampleFail = { gt: t - 1, lt: t + 1, gte: t - 1, lte: t + 1, eq: t + 1 }[op];
  const examplePass = { gt: t + 1, lt: t - 1, gte: t, lte: t, eq: t }[op];
  el.style.display = 'block';
  el.innerHTML =
    \`<div style="color:#ff6b6b">📱 <strong>Text sent</strong> when <code style="background:#1a0f0f;padding:1px 5px;border-radius:3px">\${expr}</code> is \${inverseLabel} \${t} &nbsp;—&nbsp; e.g. value is <strong>\${exampleFail}</strong></div>\` +
    \`<div style="color:#6bcb77;margin-top:4px">✅ <strong>No text</strong> when <code style="background:#0f1a0f;padding:1px 5px;border-radius:3px">\${expr}</code> is \${sym} \${t} &nbsp;—&nbsp; e.g. value is <strong>\${examplePass}</strong></div>\`;
}

function toggleReportMode() {
  const on = document.getElementById('w-report-only').checked;
  // Hide (not disable) the comparator block — in report mode those fields are
  // ignored server-side, so showing them would only invite confusion.
  document.getElementById('comparator-block').style.display = on ? 'none' : '';
  if (on) document.getElementById('ws2-err').textContent = '';
}

function updateSimpleSched() {
  const freq = document.getElementById('w-freq').value;
  document.getElementById('sched-time-col').style.opacity = freq === 'hourly' ? '.4' : '1';
  document.getElementById('sched-days-col').style.opacity = freq === 'hourly' ? '.4' : '1';
  const cron = buildLocalCron(freq, document.getElementById('w-time').value, document.getElementById('w-days').value);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offsetMin = new Date().getTimezoneOffset();
  const offsetHr = -(offsetMin / 60);
  const tzLabel = \`\${tz} (UTC\${offsetHr >= 0 ? '+' : ''}\${offsetHr})\`;
  document.getElementById('sched-preview').textContent = freq === 'hourly'
    ? 'Cron: ' + cron + ' — runs every hour'
    : \`Cron: \${cron} — times in UTC, converted from your local time (\${tzLabel})\`;
}

// ─── Alert config tabs ────────────────────────────────────────────────────────
function ws3Tab(tab) {
  const tabs = ['config', 'examples', 'webhook'];
  tabs.forEach((t) => {
    document.getElementById('ws3-' + t).style.display = (t === tab) ? 'block' : 'none';
    document.getElementById('ws3-tab-' + t).className = 'sched-tab' + (t === tab ? ' active' : '');
  });
  if (tab === 'webhook') loadWebhookState();
}

// ─── Webhook (push) management ───────────────────────────────────────────────
let _lastWebhookSecret = null;

async function loadWebhookState() {
  const stateEl = document.getElementById('wh-state');
  const monitorId = S.wizardMonitorId;

  // Always render the example curl so users can see how to call it before generating.
  // Use real values where known, placeholders otherwise.
  const curlMonitorId = monitorId || '<monitor-id>';
  const curlSecret = _lastWebhookSecret || 'cnry_v1_<your-saved-secret>';
  renderWebhookCurl(curlSecret, curlMonitorId);

  if (!monitorId) {
    stateEl.innerHTML = '<p style="font-size:12px;color:#666;margin:0">Save the alert first, then come back here to generate a key.</p>';
    document.getElementById('wh-secret-display').style.display = 'none';
    return;
  }
  try {
    const d = await api('GET', '/monitors/' + monitorId + '/webhook');
    if (d.exists) {
      stateEl.innerHTML = '<p style="font-size:13px;color:#e0e0e0;margin-bottom:10px">Active key: <code style="color:#FFD700;font-family:ui-monospace,Menlo,monospace;font-size:12px;background:#111;padding:2px 6px;border-radius:4px">' + esc(d.fingerprint) + '…</code></p>' +
        '<p style="font-size:11px;color:#666;margin-bottom:14px">Created ' + new Date(d.createdAt).toLocaleString() + '</p>' +
        '<div style="display:flex;gap:8px">' +
        '<button type="button" class="btn btn-ghost btn-sm" onclick="generateWebhookKey(true)">Rotate</button>' +
        '<button type="button" class="btn btn-danger btn-sm" onclick="revokeWebhookKey()">Revoke</button>' +
        '</div>';
      if (!_lastWebhookSecret) {
        document.getElementById('wh-secret-display').style.display = 'none';
      }
    } else {
      stateEl.innerHTML = '<p style="font-size:13px;color:var(--m);margin-bottom:14px;margin-top:0">No webhook key yet.</p>' +
        '<button type="button" class="btn btn-primary btn-sm" onclick="generateWebhookKey(false)">Generate webhook key</button>';
      document.getElementById('wh-secret-display').style.display = 'none';
    }
  } catch (e) {
    stateEl.innerHTML = '<p style="font-size:13px;color:var(--red);margin:0">Could not load webhook state: ' + esc(e.message) + '</p>';
  }
}

async function generateWebhookKey(isRotate) {
  const monitorId = S.wizardMonitorId;
  if (!monitorId) return;
  if (isRotate && !confirm('Rotate the webhook key? Any project still using the old key will start receiving 401s immediately.')) return;
  try {
    const d = await api('POST', '/monitors/' + monitorId + '/webhook');
    _lastWebhookSecret = d.secret;
    document.getElementById('wh-secret-pre').textContent = d.secret;
    document.getElementById('wh-secret-display').style.display = 'block';
    renderWebhookCurl(d.secret, monitorId);
    await loadWebhookState();
  } catch (e) {
    alert('Generate failed: ' + e.message);
  }
}

async function revokeWebhookKey() {
  const monitorId = S.wizardMonitorId;
  if (!monitorId) return;
  if (!confirm('Revoke the webhook key? Anything using it will start getting 401s.')) return;
  try {
    await api('DELETE', '/monitors/' + monitorId + '/webhook');
    _lastWebhookSecret = null;
    document.getElementById('wh-secret-display').style.display = 'none';
    await loadWebhookState();
  } catch (e) {
    alert('Revoke failed: ' + e.message);
  }
}

function renderWebhookCurl(secret, monitorId) {
  const base = location.origin;
  const url = base + '/webhook/' + monitorId + '/fire';
  const body = '{"passed":false,"observed":0,"error":"something broke","captures":{"service":"my-app"}}';
  const curl = 'curl -X POST ' + url +
    ' -H "Authorization: Bearer ' + secret + '"' +
    ' -H "Content-Type: application/json"' +
    " -d '" + body + "'";
  document.getElementById('wh-curl-pre').textContent = curl;
  const label = document.getElementById('wh-curl-label');
  if (label) {
    label.textContent = (secret.startsWith('cnry_v1_<') || monitorId.startsWith('<'))
      ? 'Generate a key below to fill in the real secret. Until then this shows the call shape with a placeholder.'
      : 'Live example using this monitor and (if just generated) your real secret.';
  }
}

function copyWebhookSecret() {
  if (!_lastWebhookSecret) return;
  navigator.clipboard.writeText(_lastWebhookSecret).then(
    () => { /* no-op success */ },
    () => alert('Could not copy — select the text manually'),
  );
}

async function sendTestAlert(channel) {
  const addrEl = document.getElementById(\`ex-\${channel}-addr\`);
  const resultEl = document.getElementById(\`ex-\${channel}-result\`);
  const btn = document.getElementById(\`ex-\${channel}-btn\`);
  const address = addrEl.value.trim();
  if (!address) { resultEl.textContent = 'Enter an address first.'; resultEl.style.color = '#f66'; return; }
  btn.disabled = true; btn.textContent = 'Sending...';
  resultEl.textContent = '';
  try {
    await api('POST', '/test-alert', { channel, address });
    resultEl.textContent = '✅ Sent! Check your ' + (channel === 'email' ? 'inbox' : 'phone') + '.';
    resultEl.style.color = '#4caf50';
  } catch (e) {
    resultEl.textContent = '❌ ' + e.message;
    resultEl.style.color = '#f66';
  } finally {
    btn.disabled = false; btn.textContent = 'Send test';
  }
}

// ─── Invite modal ─────────────────────────────────────────────────────────────
function openInviteModal() {
  document.getElementById('invite-emails').innerHTML = '';
  document.getElementById('invite-err').textContent = '';
  document.getElementById('invite-ok').textContent = '';
  addInviteEmail();
  document.getElementById('invite-modal').classList.add('open');
}

function closeInviteModal() {
  document.getElementById('invite-modal').classList.remove('open');
}

function addInviteEmail() {
  const list = document.getElementById('invite-emails');
  if (list.children.length >= 10) return;
  const row = document.createElement('div');
  row.className = 'invite-email-row';
  row.innerHTML = \`
    <input type="email" placeholder="member@example.com">
    <button class="icon-btn" onclick="this.parentElement.remove(); updateInviteAddBtn()">&#x2715;</button>
  \`;
  list.appendChild(row);
  updateInviteAddBtn();
  row.querySelector('input').focus();
}

function updateInviteAddBtn() {
  const count = document.getElementById('invite-emails').children.length;
  document.getElementById('invite-add-btn').style.display = count >= 10 ? 'none' : 'inline-flex';
}

async function sendInvites() {
  const emails = [...document.querySelectorAll('#invite-emails input')]
    .map(i => i.value.trim()).filter(Boolean);
  const btn = document.getElementById('invite-send-btn');
  const err = document.getElementById('invite-err');
  const ok = document.getElementById('invite-ok');
  if (!emails.length) { err.textContent = 'Enter at least one email address.'; return; }
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Sending...';
  err.textContent = ''; ok.textContent = '';
  try {
    const result = await api('POST', '/invites', { emails });
    const failed = (result && result.failed) || [];
    const sent = (result && result.sent) || [];
    if (failed.length) {
      // Partial success: the server returns 200 with a per-email failed[] list so
      // the admin knows exactly which invites didn't go out. Surface it instead of
      // an unqualified "Invitations sent!" (which would hide that some never sent).
      const lines = failed.map(f => f.email + ' (' + f.error + ')').join(', ');
      if (sent.length) {
        ok.textContent = 'Sent ' + sent.length + ' of ' + (sent.length + failed.length) + '.';
        err.textContent = 'Failed to send to: ' + lines;
      } else {
        err.textContent = 'No invitations were sent. Failed: ' + lines;
      }
    } else {
      ok.textContent = 'Invitations sent!';
      setTimeout(closeInviteModal, 2000);
    }
  } catch (e) { err.textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = 'Send invitations'; }
}

// ─── Add integration (one-step health-check provisioning) ─────────────────────
function openIntegrationModal() {
  ['ig-name','ig-url','ig-secret','ig-cron','ig-email','ig-sms','ig-ntfy'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('ig-err').textContent = '';
  document.getElementById('ig-ok').textContent = '';
  document.getElementById('ig-result').innerHTML = '';
  document.getElementById('integration-modal').classList.add('open');
  document.getElementById('ig-name').focus();
}

function closeIntegrationModal() {
  document.getElementById('integration-modal').classList.remove('open');
}

async function submitIntegration() {
  const name = document.getElementById('ig-name').value.trim();
  const baseUrl = document.getElementById('ig-url').value.trim();
  const secret = document.getElementById('ig-secret').value.trim();
  const cron = document.getElementById('ig-cron').value.trim();
  const recipients = [];
  const email = document.getElementById('ig-email').value.trim();
  const sms = document.getElementById('ig-sms').value.trim();
  const ntfy = document.getElementById('ig-ntfy').value.trim();
  if (email) recipients.push({ channel: 'email', address: email });
  if (sms) recipients.push({ channel: 'sms', address: sms });
  if (ntfy) recipients.push({ channel: 'ntfy', address: ntfy });

  const btn = document.getElementById('ig-submit-btn');
  const err = document.getElementById('ig-err');
  const ok = document.getElementById('ig-ok');
  const result = document.getElementById('ig-result');
  err.textContent = ''; ok.textContent = ''; result.innerHTML = '';
  if (!name || !baseUrl || !secret) { err.textContent = 'Name, base URL, and secret are required.'; return; }
  if (!recipients.length) { err.textContent = 'Add at least one alert recipient.'; return; }

  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Creating & verifying...';
  try {
    const payload = { name, baseUrl, secret, recipients };
    if (cron) payload.cron = cron;
    const res = await api('POST', '/integrations', payload);
    ok.textContent = 'Integration created!';
    const fr = res.firstRun || {};
    const badge = fr.error
      ? '<span style="color:var(--red);font-weight:600">● wiring problem</span>'
      : (fr.passed
          ? '<span style="color:var(--green);font-weight:600">● healthy</span>'
          : '<span style="color:var(--red);font-weight:600">● errors reported</span>');
    result.innerHTML = '<div style="font-size:13px;border:1px solid var(--b);border-radius:8px;padding:12px">'
      + '<div style="margin-bottom:6px">First check: ' + badge + '</div>'
      + (fr.error
          ? '<div style="color:var(--red);font-size:12px">' + esc(fr.error) + '</div>'
            + '<div style="color:var(--m);font-size:12px;margin-top:6px">Double-check the base URL and secret, then re-run from the Reports tab.</div>'
          : '<div style="color:var(--m);font-size:12px">Observed totalErrors = ' + esc(String(fr.observed)) + '. Monitoring is live.</div>')
      + '</div>';
    loadDashboard();
    setTimeout(closeIntegrationModal, fr.error ? 6000 : 2500);
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Create & verify';
  }
}

// ─── Body visibility ─────────────────────────────────────────────────────────
function updateBodyVisibility() {
  const method = document.getElementById('w-method').value;
  const show = ['POST','PUT','PATCH'].includes(method);
  document.getElementById('w-body-group').style.display = show ? 'block' : 'none';
}

function insertDefaultNtfyMessage() {
  const ta = document.getElementById('w-ntfy-message');
  ta.value = '{status}\\nMonitor: {monitor}\\nObserved: {observed}\\nTimestamp: {timestamp}';
  ta.focus();
}

function insertVar(targetId, varText) {
  const el = document.getElementById(targetId);
  if (!el) return;
  el.focus();
  const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
  const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
  el.value = el.value.slice(0, start) + varText + el.value.slice(end);
  const pos = start + varText.length;
  if (el.setSelectionRange) el.setSelectionRange(pos, pos);
}

// ─── Test request ─────────────────────────────────────────────────────────────
async function testRequest() {
  const url = document.getElementById('w-url').value.trim();
  if (!url) { document.getElementById('ws2-err').textContent = 'Enter a URL first.'; return; }

  const headers = {};
  // Scope to #headers-list so capture rows (which share the .header-row class in
  // #captures-list) aren't read as bogus headers — the test request must mirror
  // exactly what the saved check sends (see wizardStep2's identical scoping).
  document.querySelectorAll('#headers-list .header-row').forEach(row => {
    const [k, v] = row.querySelectorAll('input');
    if (k.value.trim()) headers[k.value.trim()] = v.value.trim();
  });

  const bodyVal = document.getElementById('w-body').value.trim();
  const btn = document.getElementById('test-btn');
  const resultEl = document.getElementById('test-result');
  const innerEl = document.getElementById('test-result-inner');
  const errEl = document.getElementById('test-error');

  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Testing...';
  resultEl.style.display = 'none'; errEl.style.display = 'none';
  document.getElementById('ws2-err').textContent = '';

  try {
    const data = await api('POST', '/test-request', {
      url,
      method: document.getElementById('w-method').value,
      headers,
      body: bodyVal || undefined,
    });
    innerEl.innerHTML = renderClickableJson(data.data, '');
    resultEl.style.display = 'block';
  } catch (e) {
    errEl.textContent = 'Test failed: ' + e.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Test request';
  }
}

function renderClickableJson(val, path) {
  // NB: response data is attacker-influenced (we render whatever the tested
  // endpoint returns), so every value/key is esc()'d and clicks are handled via
  // data-* attributes + delegation rather than inline onclick (no script injection).
  if (val === null) return '<span style="color:var(--m)">null</span>';
  if (typeof val === 'boolean') return \`<span style="color:#a78bfa">\${val}</span>\`;
  if (typeof val === 'number') {
    return \`<span class="json-leaf" data-path="\${esc(path)}" data-num="\${val}" style="color:var(--y);cursor:pointer" title="Click to use this value">\${val}</span>\`;
  }
  if (typeof val === 'string') {
    // A multi-line string is a pre-rendered block (the usage digest's report /
    // breakdown / trend tables) — show it WHOLE and keep its newlines and column
    // alignment, since previewing exactly what the alert will send is the point
    // of this panel. Clipping those at 80 chars hid the entire body.
    if (val.includes('\\n')) {
      return \`<pre style="margin:4px 0;padding:8px;background:var(--bg2,rgba(255,255,255,.04));border-radius:6px;white-space:pre;overflow-x:auto;color:#86efac">\${esc(val)}</pre>\`;
    }
    const display = val.length > 200 ? val.slice(0,200) + '…' : val;
    const isNum = !isNaN(Number(val)) && val !== '';
    const style = isNum ? 'color:var(--y);cursor:pointer' : 'color:#86efac';
    const attrs = isNum ? \` data-path="\${esc(path)}" data-num="\${Number(val)}"\` : '';
    return \`<span class="json-leaf" style="\${style}"\${attrs} title="\${isNum?'Click to use this value':''}">&quot;\${esc(display)}&quot;</span>\`;
  }
  if (Array.isArray(val)) {
    if (!val.length) return '<span style="color:var(--m)">[]</span>';
    const items = val.map((v,i) => {
      const p = path ? path+'.'+i : String(i);
      return '<div style="padding-left:16px">' + renderClickableJson(v, p) + '</div>';
    }).join('');
    return '<span style="color:var(--m)">[</span>' + items + '<span style="color:var(--m)">]</span>';
  }
  if (typeof val === 'object') {
    const entries = Object.entries(val).map(([k, v]) => {
      const p = path ? path+'.'+k : k;
      return \`<div style="padding-left:16px"><span style="color:#93c5fd">&quot;\${esc(k)}&quot;</span><span style="color:var(--m)">: </span>\${renderClickableJson(v, p)}</div>\`;
    }).join('');
    return '<span style="color:var(--m)">{</span>' + entries + '<span style="color:var(--m)">}</span>';
  }
  return esc(String(val));
}

function selectJsonValue(path, num) {
  document.getElementById('w-expr').value = path;
  document.getElementById('w-threshold').value = num;
  document.getElementById('w-expr').style.borderColor = 'var(--y)';
  document.getElementById('w-threshold').style.borderColor = 'var(--y)';
  setTimeout(() => {
    document.getElementById('w-expr').style.borderColor = '';
    document.getElementById('w-threshold').style.borderColor = '';
  }, 1500);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function clearErr() {
  ['ws1-err','ws2-err','ws3-err','ws3-ok'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = '';
  });
}

// Close invite modal on overlay click
document.getElementById('invite-modal').addEventListener('click', function(e) {
  if (e.target === this) closeInviteModal();
});

// Close integration modal on overlay click
document.getElementById('integration-modal').addEventListener('click', function(e) {
  if (e.target === this) closeIntegrationModal();
});
document.getElementById('relay-modal').addEventListener('click', function(e) {
  if (e.target === this) closeRelayModal();
});

// Close run-detail modal on overlay click
document.getElementById('run-detail-modal').addEventListener('click', function(e) {
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) { copyRunPart(copyBtn.dataset.copy, copyBtn); return; }
  if (e.target === this) closeRunDetail();
});

// Enter key on login
document.getElementById('li-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('li-user').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('li-pass').focus(); });

// ─── Init ─────────────────────────────────────────────────────────────────────
(async function init() {
  const path = location.pathname;
  const token = new URLSearchParams(location.search).get('token');
  if (path === '/invite/accept' && token) {
    showView('invite-accept');
    initInviteAccept();
  } else if (S.token) {
    showView('dashboard');
  } else {
    showView('login');
  }
  document.getElementById('w-method').addEventListener('change', updateBodyVisibility);
  // Delegated click for drilling into a failed report row's request/response.
  const rl = document.getElementById('reports-list');
  if (rl) rl.addEventListener('click', (e) => {
    const purge = e.target.closest('[data-purge-run]');
    if (purge) {
      purgeRun(purge.dataset.monitorid, purge.dataset.timestamp, purge.dataset.runid, purge);
      return;
    }
    const dismiss = e.target.closest('[data-dismiss-corrupt]');
    if (dismiss) {
      dismissCorrupt(dismiss.dataset.monitorid, dismiss);
      return;
    }
    const row = e.target.closest('[data-run-detail]');
    if (row) openRunDetail(row.dataset.monitorid, row.dataset.timestamp, row.dataset.runid);
  });
  // Legacy-orphan purge form: user supplies timestamp + runId from the logs.
  if (rl) rl.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-purge-legacy]');
    if (!form) return;
    e.preventDefault();
    purgeRun(form.dataset.monitorid, form.timestamp.value.trim(), form.runid.value.trim(),
      form.querySelector('button[type="submit"]'));
  });
  // Delegated click for clickable JSON leaves in the Test-request viewer
  // (replaces inline onclick so injected response content can't run script).
  const tri = document.getElementById('test-result-inner');
  if (tri) tri.addEventListener('click', (e) => {
    const leaf = e.target.closest('.json-leaf[data-path]');
    if (leaf) selectJsonValue(leaf.dataset.path, Number(leaf.dataset.num));
  });
  // Delegated delete for secret rows (keys are user-controlled — no inline JS).
  const sl = document.getElementById('d-secret-list');
  if (sl) sl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-del-secret]');
    if (b) deleteSecret(b.getAttribute('data-del-secret'));
  });
  buildTimeOptions();
})();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Constant-time string compare (length may leak) so a bearer check can't reveal
 *  the secret via response timing. */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function html(content: string): Response {
  return new Response(content, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      // The SPA is built on inline handlers/styles so 'unsafe-inline' is
      // required, but we still block externally-loaded/injected scripts,
      // framing (clickjacking) and base/object vectors as defense-in-depth.
      "Content-Security-Policy": [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorResponse(e: unknown): Response {
  if (e instanceof CanaryError) {
    // Handled client errors (4xx validation/not-found) are expected — debug only.
    log.debug(`❌ errorResponse: CanaryError fault=${e.fault} status=${e.status} message=${e.message}`);
    return json({ error: e.fault, message: e.message }, e.status);
  }
  const msg = e instanceof Error ? e.message : String(e);
  log.error("❌ errorResponse: unhandled error:", msg, (e instanceof Error ? e.stack : ""));
  // Don't leak internal error details (KV internals, dependency text) to clients.
  return json({ error: "internal-error", message: "An unexpected error occurred" }, 500);
}

async function parseBody<T>(req: Request): Promise<T> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new CanaryError("validation-error", "Request body must be valid JSON", 400);
  }
  // Every route expects a JSON object body. Reject null/array/string/number up
  // front so a handler that reads a field (e.g. payload.passed) can't throw a
  // raw TypeError → 500 on a non-object body.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CanaryError("validation-error", "Request body must be a JSON object", 400);
  }
  return parsed as T;
}

// decodeURIComponent throws URIError on a malformed percent-escape (e.g. "%E0%A4%A").
// A bad path segment is client input → 400, not a server fault → 500.
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new CanaryError("validation-error", `Malformed URL-encoded path segment: "${segment}"`, 400);
  }
}

function extractToken(req: Request): string {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new CanaryError("unauthorized", "Missing Authorization header", 401);
  return token;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

// onListen overrides Deno.serve's default stdout "Listening on …" line, which
// Deno Deploy reprints on every isolate spin-up and floods the logs. Route it
// through our logger at debug level so it's hidden at the normal info level.
Deno.serve({ onListen: ({ hostname, port }) => log.debug(`🚀 Listening on http://${hostname}:${port}/`) }, async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;
  const authHeader = req.headers.get("Authorization") ?? "(none)";
  const tokenSnippet = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7, 15) + "..."
    : "(no token)";
  log.debug(`🌐 ${method} ${pathname} | auth: ${tokenSnippet}`);

  try {
    // SPA shell
    if (method === "GET" && (pathname === "/" || pathname === "/invite/accept")) {
      return html(INDEX_HTML);
    }

    // Favicon
    if (method === "GET" && pathname === "/favicon.svg") {
      return new Response(FAVICON_SVG, {
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
      });
    }

    // Public JSON status
    if (method === "GET" && pathname === "/api/status") {
      const monitors = await listMonitors();
      const statusData = { status: "ok", startedAt, lastCronTick, monitors: monitors.monitors.length };
      log.debug(`✅ GET /api/status → 200 monitors=${statusData.monitors}`);
      return json(statusData);
    }

    // Deno Deploy usage digest — the daily-digest monitor polls this. Bearer-
    // authed with DD_USAGE_SECRET (the monitor injects it via a stored secret),
    // NOT admin-session gated (the cron runner carries no session). Returns
    // org-wide usage summed across every app for the last `hours` (default 24).
    if (method === "GET" && pathname === "/api/deno-usage") {
      const secret = Deno.env.get("DD_USAGE_SECRET");
      if (!secret) return json({ error: "DD_USAGE_SECRET is not configured" }, 503);
      const auth = req.headers.get("Authorization") ?? "";
      if (!timingSafeEqualStr(auth, `Bearer ${secret}`)) return json({ error: "unauthorized" }, 401);
      // Window params (?hours= / ?day=yesterday / ?from=&to=) are resolved by
      // the adapter, which validates them and throws a 400 on bad input.
      const usage = await getDenoUsage(url.searchParams);
      log.info(`✅ GET /api/deno-usage → 200 ${usage.window.label} apps=${usage.apps} errored=${usage.appsErrored}`);
      return json(usage);
    }

    // Deno Deploy real usage-based spend ($) + live spend limit, read from the
    // console's billing API with a session cookie. Same bearer as /api/deno-usage.
    // The spend-guardrail monitor polls this; extract `pctOfLimit`.
    if (method === "GET" && pathname === "/api/deno-spend") {
      const secret = Deno.env.get("DD_USAGE_SECRET");
      if (!secret) return json({ error: "DD_USAGE_SECRET is not configured" }, 503);
      const auth = req.headers.get("Authorization") ?? "";
      if (!timingSafeEqualStr(auth, `Bearer ${secret}`)) return json({ error: "unauthorized" }, 401);
      const spend = await getDenoSpend();
      log.info(`✅ GET /api/deno-spend → 200 pct=${spend.pctOfLimit}`);
      return json(spend);
    }

    // Public: login
    if (method === "POST" && pathname === "/auth/login") {
      const body = await parseBody<{ username: string; password: string }>(req);
      log.debug(`🔍 POST /auth/login: username="${body.username}"`);
      const session = await login(body.username, body.password);
      log.debug(`✅ POST /auth/login → 200 username="${body.username}"`);
      return json(session);
    }

    // Public: invite info (email hint for accept page)
    if (method === "GET" && pathname === "/invite/info") {
      const token = url.searchParams.get("token") ?? "";
      if (!token) throw new CanaryError("validation-error", "Missing token", 400);
      // peek without consuming
      const { kv: kvStore } = await import("./dist.rune/impure/_kv.ts");
      const entry = await kvStore.get<{ email: string }>(["invite", token], { consistency: "strong" });
      if (!entry.value) throw new CanaryError("not-found", "Invite not found or expired", 404);
      return json({ email: entry.value.email });
    }

    // Public: accept invite
    if (method === "POST" && pathname === "/invite/accept") {
      const body = await parseBody<{ token: string; password: string }>(req);
      // Validate the token is a present, non-empty string BEFORE it reaches
      // peekInvite → kv.get(["invite", token]). A missing/non-string token would
      // otherwise hit KV as an invalid key part (raw TypeError → opaque 500) on
      // this public route; surface a clean 400 instead (mirrors /invite/info).
      requireString(body.token, "token");
      // Peek (don't consume) so a failed createUser/login leaves the single-use
      // token intact for a retry. createUser enforces the password policy.
      const email = await peekInvite(body.token);
      // Try to create the account. If the email is ALREADY a user — because it
      // was registered out of band, or because a concurrent double-submit of the
      // same token already won the create race — createUser throws a 409. In
      // that case fall back to a plain login: if the supplied password matches
      // the existing account, the invitee still gets a session (and the token is
      // consumed). This avoids a permanent dead-token lockout where retrying the
      // accept page would 409 forever, and makes a benign double-submit return a
      // session instead of a confusing "User already exists".
      try {
        await createUser(email, body.password);
      } catch (e) {
        const err = e as { fault?: string };
        if (err.fault !== "conflict") throw e;
        log.info(`🔍 invite/accept: account already exists for ${email} — attempting login`);
      }
      // login() throws 401 on a wrong password; the token stays alive so the
      // invitee can retry with the right one.
      const session = await login(email, body.password);
      // Only burn the token once a session was issued.
      await markInviteConsumed(body.token);
      return json(session);
    }

    // Public: webhook fire (external projects push alerts via per-monitor bearer secret)
    const fireMatch = pathname.match(/^\/webhook\/([^/]+)\/fire$/);
    if (fireMatch && method === "POST") {
      const monitorId = fireMatch[1];
      const auth = req.headers.get("Authorization") ?? "";
      const plaintextSecret = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!plaintextSecret) {
        throw new CanaryError("unauthorized", "Missing Authorization: Bearer cnry_v1_... header", 401);
      }
      const payload = await parseBody<FireAlertDto>(req);
      log.info(`🪝 POST /webhook/${monitorId}/fire passed=${payload.passed ?? false} observed=${payload.observed ?? 0} hasError=${!!payload.error} hasOverride=${!!(payload.message || payload.title)}`);
      const result = await webhookFire({ monitorId, plaintextSecret, payload });
      return json({
        runId: result.runResult.runId,
        fired: result.fired,
        channels: result.channels,
      });
    }

    // Public: relay fire (external projects push a raw error to a relay monitor's
    // SMS numbers). The shared token is accepted EITHER as `Authorization: Bearer`
    // (the conventional path, matching /webhook/:monitorId/fire) OR in the body as
    // `test`. Any extra top-level body fields (source, kind, phone, …) are folded
    // into the run's captures by fireRelay.
    const relayFireMatch = pathname.match(/^\/relay\/([^/]+)\/fire$/);
    if (relayFireMatch && method === "POST") {
      const monitorId = safeDecode(relayFireMatch[1]);
      const payload = await parseBody<RelayFireDto>(req);
      const auth = req.headers.get("Authorization") ?? "";
      const headerToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const token = headerToken || (typeof payload.test === "string" ? payload.test : "");
      if (!token) {
        throw new CanaryError("unauthorized", "Missing relay token (send Authorization: Bearer <token>, or \"test\" in the JSON body)", 401);
      }
      log.info(`📮 POST /relay/${monitorId}/fire hasError=${!!payload.error} hasOverride=${!!payload.message}`);
      const result = await fireRelay({ monitorId, token, payload });
      return json(result);
    }

    // ── All routes below require auth ────────────────────────────────────────
    const token = extractToken(req);
    await validateSession(token);

    // Logout
    if (method === "POST" && pathname === "/auth/logout") {
      await logout(token);
      log.debug(`✅ POST /auth/logout → 200`);
      return json({ ok: true });
    }

    // Diagnostic snapshot — auth-gated dump of KV state for triage
    if (method === "GET" && pathname === "/api/debug") {
      const now = new Date();
      const monitorsResult = await listMonitors();

      // A single undeserializable check/alert row would otherwise throw mid-scan
      // and blank out the WHOLE debug snapshot — exactly when an operator needs
      // it most. Isolate the failure so the rest of the snapshot still decodes,
      // mirroring how /api/reports tolerates a corrupt run row per-monitor.
      const checks: Array<Record<string, unknown>> = [];
      try {
        for await (const entry of kv.list<CheckDto>({ prefix: ["check"] })) {
          const c = entry.value;
          checks.push({
            monitorId: c.monitorId,
            url: c.url,
            method: c.method,
            expression: c.expression,
            comparatorOp: c.comparatorOp,
            threshold: c.threshold,
            cron: c.cron,
            notifyOnRecover: c.notifyOnRecover,
            notifyOnSuccess: c.notifyOnSuccess === true,
            logsUrl: c.logsUrl,
            matchesNow: cronMatchesNow(c.cron, now),
          });
        }
      } catch (e) {
        log.warn(`⚠️ /api/debug: check scan truncated at an unreadable row — ${(e as Error).message}`);
        checks.push({ error: "check scan truncated at an unreadable row" });
      }

      const alerts: Array<Record<string, unknown>> = [];
      try {
        for await (const entry of kv.list<AlertDto>({ prefix: ["alert"] })) {
          const a = entry.value;
          alerts.push({
            monitorId: a.monitorId,
            recipientCount: a.recipients.length,
            channels: a.recipients.map((r) => r.channel),
            hasCustomEmailSubject: !!a.emailSubject,
            hasCustomEmailMessage: !!a.emailMessage,
            hasCustomSmsMessage: !!a.smsMessage,
            hasCustomNtfyTitle: !!a.ntfyTitle,
            hasCustomNtfyMessage: !!a.ntfyMessage,
          });
        }
      } catch (e) {
        log.warn(`⚠️ /api/debug: alert scan truncated at an unreadable row — ${(e as Error).message}`);
        alerts.push({ error: "alert scan truncated at an unreadable row" });
      }

      const latestRuns: Array<Record<string, unknown>> = [];
      const webhooks: Array<Record<string, unknown>> = [];
      for (const m of monitorsResult.monitors) {
        const latest = await RunResult.getLatest(m.monitorId);
        latestRuns.push({
          monitorId: m.monitorId,
          monitorName: m.name,
          hasRun: latest !== null,
          passed: latest?.passed ?? null,
          observed: latest?.observed ?? null,
          timestamp: latest?.timestamp ?? null,
          error: latest?.error ?? null,
        });
        const wh = await WebhookSecret.peek(m.monitorId);
        webhooks.push({
          monitorId: m.monitorId,
          monitorName: m.name,
          exists: wh.exists,
          fingerprint: wh.fingerprint ?? null,
          createdAt: wh.createdAt ?? null,
        });
      }

      return json({
        now: now.toISOString(),
        startedAt,
        lastCronTick,
        monitors: monitorsResult.monitors.map((m) => ({
          monitorId: m.monitorId,
          name: m.name,
          description: m.description,
        })),
        checks,
        alerts,
        latestRuns,
        webhooks,
        env: {
          ZAPIER_SMS_URL: !!Deno.env.get("ZAPIER_SMS_URL"),
          POSTMARK_SERVER_TOKEN: !!Deno.env.get("POSTMARK_SERVER_TOKEN"),
          POSTMARK_FROM_EMAIL: Deno.env.get("POSTMARK_FROM_EMAIL") ?? null,
          ADMIN_USERNAME: Deno.env.get("ADMIN_USERNAME") ?? null,
        },
      });
    }

    // Reports — recent fired checks grouped by configured check (bounded query).
    // KV timestamps are ISO-8601 UTC, so they sort lexicographically = chronologically.
    if (method === "GET" && pathname === "/api/reports") {
      const WINDOWS: Record<string, number> = { "24h": 864e5, "7d": 6048e5, "30d": 2592e6 };
      const windowKey = url.searchParams.get("window") ?? "24h";
      if (!(windowKey in WINDOWS)) {
        throw new CanaryError("validation-error", `Unknown window "${windowKey}" — use 24h, 7d, or 30d`, 400);
      }
      const PER_CHECK_CAP = 500; // safety cap so a per-minute monitor can't return thousands of rows
      const cutoff = new Date(Date.now() - WINDOWS[windowKey]).toISOString();
      log.debug(`🔍 GET /api/reports window=${windowKey} cutoff=${cutoff}`);

      const monitorsResult = await listMonitors();
      const reports: Array<Record<string, unknown>> = [];

      for (const m of monitorsResult.monitors) {
        // Check config supplies the observed-vs-threshold context; may not exist yet.
        let check: CheckDto | null = null;
        try {
          check = await getCheck({ monitorId: m.monitorId });
        } catch {
          check = null;
        }

        // The per-monitor walk (batchSize:1 corrupt-row resilience, run_idx
        // recovery, dismiss filter) lives in RunResult.scanWindow so it's covered
        // by the dist.rune test suite.
        const { runs, passed, corrupt, capped } = await RunResult.scanWindow(
          m.monitorId,
          cutoff,
          PER_CHECK_CAP,
        );

        reports.push({
          monitorId: m.monitorId,
          name: m.name,
          description: m.description,
          type: m.type, // "check" | "relay" — the UI labels relay monitors differently
          expression: check?.expression ?? null,
          comparatorOp: check?.comparatorOp ?? null,
          threshold: check?.threshold ?? null,
          total: runs.length,
          passed,
          failed: runs.length - passed,
          capped,
          runs,
          corrupt,
        });
      }

      log.debug(`✅ GET /api/reports → 200 window=${windowKey} checks=${reports.length}`);
      return json({ window: windowKey, generatedAt: new Date().toISOString(), reports });
    }

    // Single run detail — full request/response for drilling into a failed check.
    const runDetailMatch = pathname.match(/^\/api\/runs\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (runDetailMatch && method === "GET") {
      const [, monitorId, timestamp, runId] = runDetailMatch.map((s, i) => i === 0 ? s : safeDecode(s));
      const entry = await kv.get<RunResultDto>(["run", monitorId, timestamp, runId]);
      if (!entry.value) throw new CanaryError("not-found", "Run not found", 404);
      log.debug(`✅ GET /api/runs/${monitorId}/${timestamp}/${runId} → 200`);
      return json(entry.value);
    }
    // Purge a single run row by exact key. Deletes by key only (no read), so it
    // works even when the value is undeserializable — this is how a corrupt run
    // surfaced on the Reports tab gets removed. Drops the run_idx sidecar too.
    if (runDetailMatch && method === "DELETE") {
      const [, monitorId, timestamp, runId] = runDetailMatch.map((s, i) => i === 0 ? s : safeDecode(s));
      const purged = await RunResult.purge(monitorId, timestamp, runId);
      if (!purged) {
        // Atomic delete rejected — the corrupt row is still in KV. Surface a
        // failure so the "Purge row" button can prompt a retry instead of
        // reporting success and silently re-showing the banner on reload.
        throw new CanaryError("purge-failed", "Could not purge run row — retry", 500);
      }
      log.info(`🗑️ DELETE /api/runs/${monitorId}/${timestamp}/${runId} → 200 (purged run + index)`);
      return json({ ok: true });
    }
    // Dismiss the "legacy unreadable row" banner for a monitor. A pre-index
    // (sidecar-less) corrupt row has no recoverable key, so it can't be deleted —
    // this records an acknowledgement so the Reports tab stops surfacing it. Only
    // suppresses the unrecoverable (exact:false) banner; genuinely purgeable rows
    // (exact:true) always surface their one-click delete.
    const dismissCorruptMatch = pathname.match(/^\/api\/reports\/([^/]+)\/dismiss-corrupt$/);
    if (dismissCorruptMatch && method === "POST") {
      const monitorId = safeDecode(dismissCorruptMatch[1]);
      await RunResult.dismissCorrupt(monitorId);
      log.info(`🙈 POST /api/reports/${monitorId}/dismiss-corrupt → 200 (legacy corrupt-row banner dismissed)`);
      return json({ ok: true });
    }

    // Webhook key management — admin-only, scoped by monitorId
    const webhookKeyMatch = pathname.match(/^\/monitors\/([^/]+)\/webhook$/);
    if (webhookKeyMatch) {
      const monitorId = webhookKeyMatch[1];
      if (method === "POST") {
        // Ensure monitor exists before issuing a key
        await getMonitor({ monitorId });
        const result = await WebhookSecret.generate(monitorId);
        log.info(`✅ POST /monitors/${monitorId}/webhook → 200 fingerprint=${result.fingerprint}`);
        return json({
          secret: result.plaintext,
          fingerprint: result.fingerprint,
          createdAt: result.createdAt,
          warning: "Save this secret now — it will not be shown again.",
        });
      }
      if (method === "GET") {
        const wh = await WebhookSecret.peek(monitorId);
        return json(wh);
      }
      if (method === "DELETE") {
        await WebhookSecret.revoke(monitorId);
        log.info(`✅ DELETE /monitors/${monitorId}/webhook → 200`);
        return json({ revoked: true });
      }
    }

    // Users
    if (method === "POST" && pathname === "/users") {
      const body = await parseBody<{ username: string; password: string }>(req);
      log.debug(`🔍 POST /users: username="${body.username}"`);
      await createUser(body.username, body.password);
      log.debug(`✅ POST /users → 201 username="${body.username}"`);
      return json({ ok: true }, 201);
    }
    if (method === "GET" && pathname === "/users") {
      const users = await listUsers();
      log.debug(`✅ GET /users → 200 count=${users.users.length}`);
      return json(users);
    }
    const userMatch = pathname.match(/^\/users\/([^/]+)$/);
    if (userMatch && method === "DELETE") {
      const username = safeDecode(userMatch[1]);
      log.debug(`🔍 DELETE /users/${username}`);
      await deleteUser(username);
      log.debug(`✅ DELETE /users/${username} → 200`);
      return json({ ok: true });
    }

    // Invites
    if (method === "POST" && pathname === "/invites") {
      const body = await parseBody<{ emails: string[] }>(req);
      const fromEmail = Deno.env.get("POSTMARK_FROM_EMAIL") ?? "";
      const postmarkToken = Deno.env.get("POSTMARK_SERVER_TOKEN") ?? "";
      const baseUrl = `${url.protocol}//${url.host}`;
      const result = await createInvites(body.emails, baseUrl, fromEmail, postmarkToken);
      return json({ ok: true, ...result });
    }

    // Test request proxy
    if (method === "POST" && pathname === "/test-request") {
      const body = await parseBody<{ url: string; method: string; headers?: Record<string, string>; body?: string }>(req);
      // An `internal:` url is a producer Canary runs in-process, not a fetch —
      // resolve it here so the wizard's Test request button previews the same
      // payload the runner will see. Admin-gated like the rest of this route.
      if (isInternalUrl(body.url)) {
        const internal = await runInternal(body.url);
        return json({ status: internal.status, ok: true, data: JSON.parse(internal.payload) });
      }
      // SSRF guard: block proxying to internal/loopback/metadata hosts so this
      // request-and-read primitive can't reach the deployment's private network.
      // fetchNoSsrfRedirect re-applies the guard on every redirect hop so a
      // public host can't 3xx-bounce the proxy onto an internal/metadata address.
      assertFetchableUrl(body.url);
      const forwardHeaders: Record<string, string> = { ...(body.headers ?? {}) };
      if (body.body) forwardHeaders["Content-Type"] = forwardHeaders["Content-Type"] ?? "application/json";
      log.debug(`🔍 test-request → ${body.method} ${body.url}`);
      log.debug(`🔍 test-request headers:`, JSON.stringify(redactHeaders(forwardHeaders)));
      log.debug(`🔍 test-request body:`, body.body ?? "(none)");
      // Bound the wall-clock so a slow-loris endpoint can't pin an isolate, and
      // cap the buffered body so a huge response can't exhaust memory — mirrors
      // the production runner (http source).
      const TEST_TIMEOUT_MS = Number(Deno.env.get("FETCH_TIMEOUT_MS")) || 10000;
      const TEST_MAX_BODY = 64 * 1024;
      let res: Response;
      try {
        res = await fetchNoSsrfRedirect(body.url, {
          method: body.method,
          headers: forwardHeaders,
          body: body.body ?? undefined,
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        });
      } catch (e) {
        log.debug(`❌ test-request fetch threw:`, (e as Error).message);
        if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") {
          throw new CanaryError("timed-out", `Timed out after ${TEST_TIMEOUT_MS}ms reaching ${body.url}`, 504);
        }
        throw new CanaryError("request-failed", `Could not reach ${body.url}: ${(e as Error).message}`, 502);
      }
      const rawText = await res.text();
      const text = rawText.length > TEST_MAX_BODY ? rawText.slice(0, TEST_MAX_BODY) + "…(truncated)" : rawText;
      log.debug(`🔍 test-request response status:`, res.status);
      log.debug(`🔍 test-request response body:`, text.slice(0, 500));
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = text; }
      return json({ status: res.status, ok: res.ok, data });
    }

    // Monitors
    if (method === "POST" && pathname === "/monitors") {
      const body = await parseBody(req);
      log.debug(`🔍 POST /monitors: body=${JSON.stringify(body)}`);
      const result = await createMonitor(body as Parameters<typeof createMonitor>[0]);
      log.info(`✅ POST /monitors → 201 monitorId=${result.monitorId} name="${result.name}"`);
      return json(result, 201);
    }
    if (method === "GET" && pathname === "/monitors") {
      const result = await listMonitors();
      log.debug(`✅ GET /monitors → 200 count=${result.monitors.length}`);
      return json(result);
    }
    const monitorMatch = pathname.match(/^\/monitors\/([^/]+)$/);
    if (monitorMatch && method === "GET") {
      const monitorId = monitorMatch[1];
      log.debug(`🔍 GET /monitors/${monitorId}`);
      const result = await getMonitor({ monitorId });
      log.debug(`✅ GET /monitors/${monitorId} → 200 name="${result.name}"`);
      return json(result);
    }
    if (monitorMatch && method === "PATCH") {
      const monitorId = monitorMatch[1];
      const body = await parseBody(req);
      log.debug(`🔍 PATCH /monitors/${monitorId}: body=${JSON.stringify(body)}`);
      // Path id wins over any id in the body.
      const result = await updateMonitor({ ...(body as Record<string, unknown>), monitorId } as Parameters<typeof updateMonitor>[0]);
      log.info(`✅ PATCH /monitors/${monitorId} → 200 name="${result.name}"`);
      return json(result);
    }
    if (monitorMatch && method === "DELETE") {
      const monitorId = safeDecode(monitorMatch[1]);
      log.info(`🗑️ DELETE /monitors/${monitorId}`);
      const result = await deleteMonitor({ monitorId });
      log.debug(`✅ DELETE /monitors/${monitorId} → 200`);
      return json(result);
    }

    // Integrations — one-step provisioning of a standard health-check monitor
    // (monitor + secret + check + alert) plus an immediate verification run.
    if (method === "POST" && pathname === "/integrations") {
      const body = await parseBody(req) as Parameters<typeof createIntegration>[0];
      log.info(`🔌 POST /integrations: name="${(body as { name?: string }).name ?? ""}"`);
      const result = await createIntegration(body);
      log.info(`✅ POST /integrations → 201 monitorId=${result.monitorId} firstRunPassed=${result.firstRun.passed}`);
      return json(result, 201);
    }

    // Check
    const checkMatch = pathname.match(/^\/monitors\/([^/]+)\/check$/);
    if (checkMatch) {
      const monitorId = checkMatch[1];
      if (method === "POST") {
        const body = await parseBody(req);
        // Redact sensitive header values (e.g. a literal Authorization bearer)
        // before logging the check config — the raw body must never hit the logs.
        const safeBody = { ...(body as Record<string, unknown>) };
        if (safeBody.headers && typeof safeBody.headers === "object") {
          safeBody.headers = redactHeaders(safeBody.headers as Record<string, string>);
        }
        log.debug(`🔍 POST /monitors/${monitorId}/check: body=${JSON.stringify(safeBody)}`);
        const result = await configureCheck({ ...(body as object), monitorId } as Parameters<typeof configureCheck>[0]);
        log.debug(`✅ POST /monitors/${monitorId}/check → 200`);
        return json(result);
      }
      if (method === "GET") {
        log.debug(`🔍 GET /monitors/${monitorId}/check`);
        const result = await getCheck({ monitorId });
        log.debug(`✅ GET /monitors/${monitorId}/check → 200 url=${result.url}`);
        return json(result);
      }
    }

    // Alert
    const alertMatch = pathname.match(/^\/monitors\/([^/]+)\/alert$/);
    if (alertMatch) {
      const monitorId = alertMatch[1];
      if (method === "POST") {
        const body = await parseBody(req);
        log.debug(`🔍 POST /monitors/${monitorId}/alert: recipients=${(body as { recipients?: unknown[] }).recipients?.length ?? 0}`);
        const result = await configureAlert({ ...(body as object), monitorId } as Parameters<typeof configureAlert>[0]);
        log.debug(`✅ POST /monitors/${monitorId}/alert → 200`);
        return json(result);
      }
      if (method === "GET") {
        log.debug(`🔍 GET /monitors/${monitorId}/alert`);
        const result = await getAlert({ monitorId });
        log.debug(`✅ GET /monitors/${monitorId}/alert → 200 recipients=${result.recipients.length}`);
        return json(result);
      }
      if (method === "DELETE") {
        log.debug(`🔍 DELETE /monitors/${monitorId}/alert`);
        try {
          const result = await deleteAlert({ monitorId });
          log.info(`🗑️ DELETE /monitors/${monitorId}/alert → 200 (alert config removed)`);
          return json(result);
        } catch (e) {
          // The button is always shown, so deleting when no alert is configured
          // is a quiet no-op success rather than a surfaced 404.
          if (e instanceof CanaryError && e.fault === "not-found") {
            log.debug(`🔍 DELETE /monitors/${monitorId}/alert → 200 (no alert to delete)`);
            return json({ ok: true, deleted: false });
          }
          throw e;
        }
      }
    }

    // Schedule builder
    if (method === "POST" && pathname === "/schedule/build") {
      return json(buildSchedule(await parseBody(req) as Parameters<typeof buildSchedule>[0]));
    }

    // Secrets
    if (method === "POST" && pathname === "/secrets") {
      const body = await parseBody(req) as Parameters<typeof setSecret>[0];
      log.debug(`🔍 POST /secrets: key=${body.secretKey}`);
      const result = await setSecret(body);
      log.debug(`✅ POST /secrets → 200 key=${body.secretKey}`);
      return json(result);
    }
    if (method === "GET" && pathname === "/secrets") {
      const result = await listSecrets();
      log.debug(`✅ GET /secrets → 200 count=${result.secrets.length}`);
      return json(result);
    }
    const secretMatch = pathname.match(/^\/secrets\/([^/]+)$/);
    if (secretMatch && method === "DELETE") {
      const secretKey = safeDecode(secretMatch[1]);
      log.debug(`🔍 DELETE /secrets/${secretKey}`);
      const result = await deleteSecret({ secretKey });
      log.debug(`✅ DELETE /secrets/${secretKey} → 200`);
      return json(result);
    }

    // Relays — a monitor of type "relay" (admin manages; fired publicly above).
    // POST /relays provisions the monitor + config in one call (like /integrations).
    if (method === "POST" && pathname === "/relays") {
      const body = await parseBody<CreateRelayDto>(req);
      const result = await createRelayMonitor(body);
      log.debug(`✅ POST /relays → 200 monitorId=${result.monitorId}`);
      return json(result);
    }
    // Per-monitor relay config: GET prefill (no token hash), POST reconfigure,
    // DELETE removes the whole relay monitor.
    const relayConfigMatch = pathname.match(/^\/monitors\/([^/]+)\/relay$/);
    if (relayConfigMatch) {
      const monitorId = safeDecode(relayConfigMatch[1]);
      if (method === "GET") {
        const result = await new Relay().get(monitorId); // throws not-found
        return json(result);
      }
      if (method === "POST") {
        const body = await parseBody<Omit<ConfigureRelayDto, "monitorId">>(req);
        const result = await configureRelay({ ...body, monitorId });
        log.debug(`✅ POST /monitors/${monitorId}/relay → 200`);
        return json(result);
      }
    }
    const relayDeleteMatch = pathname.match(/^\/relays\/([^/]+)$/);
    if (relayDeleteMatch && method === "DELETE") {
      const monitorId = safeDecode(relayDeleteMatch[1]);
      log.debug(`🔍 DELETE /relays/${monitorId}`);
      const result = await deleteRelay({ monitorId });
      log.debug(`✅ DELETE /relays/${monitorId} → 200`);
      return json(result);
    }

    // Manual run
    const runMatch = pathname.match(/^\/run\/([^/]+)$/);
    if (runMatch && method === "POST") {
      const monitorId = runMatch[1];
      log.info(`🔍 POST /run/${monitorId}: triggering manual run`);
      const result = await executeRunner({ monitorId });
      log.debug(`✅ POST /run/${monitorId} → 200 passed=${result.passed} observed=${result.observed}`);
      return json(result);
    }

    // Test alert (send a real email, SMS, or ntfy push to verify config)
    if (method === "POST" && pathname === "/test-alert") {
      const body = await parseBody(req) as { channel: string; address: string; emailSubject?: string; emailMessage?: string; smsMessage?: string; ntfyTitle?: string; ntfyMessage?: string };
      // Require STRINGS, not just truthy: a JSON-number address (e.g. a phone
      // number sent unquoted) is truthy but makes Sms.send()/normalizeNtfyUrl()
      // call .replace()/.trim() on a number → raw TypeError → opaque 500. Mirror
      // configureAlert, which type-checks channel + address before use.
      if (typeof body.channel !== "string" || body.channel === "") {
        throw new CanaryError("validation-error", "channel is required and must be a string", 400);
      }
      if (typeof body.address !== "string" || body.address.trim() === "") {
        throw new CanaryError("validation-error", "address is required and must be a string", 400);
      }
      const fakeRun: RunResultDto = {
        runId: "test-" + Date.now(),
        monitorId: "test",
        monitorName: "Example Monitor",
        observed: 42,
        passed: false,
        timestamp: new Date().toISOString(),
      };
      const fakeAlert: AlertDto = {
        monitorId: "test",
        recipients: [],
        emailSubject: body.emailSubject,
        emailMessage: body.emailMessage,
        smsMessage: body.smsMessage,
        ntfyTitle: body.ntfyTitle,
        ntfyMessage: body.ntfyMessage,
      };
      if (body.channel === "email") {
        log.info(`📧 test-alert: sending email to ${body.address}`);
        const ch = new Email(body.address);
        await ch.send(fakeRun, fakeAlert);
      } else if (body.channel === "sms") {
        log.info(`📱 test-alert: sending SMS to ${body.address}`);
        const ch = new Sms(body.address);
        await ch.send(fakeRun, fakeAlert);
      } else if (body.channel === "ntfy") {
        log.info(`🔔 test-alert: sending ntfy to ${body.address}`);
        const ch = new Ntfy(body.address);
        await ch.send(fakeRun, fakeAlert);
      } else {
        throw new CanaryError("validation-error", `Unknown channel: ${body.channel}`, 400);
      }
      log.info(`✅ test-alert: sent ${body.channel} to ${body.address}`);
      return json({ sent: true });
    }

    return json({ error: "not-found", message: `No route for ${method} ${pathname}` }, 404);
  } catch (e) {
    // errorResponse() logs unhandled errors at error level; this trace is the
    // per-request diagnostic (includes handled 4xx), so keep it at debug.
    log.debug(`❌ request error: ${(e as Error).message}`, (e as Error).stack);
    return errorResponse(e);
  }
});

log.debug("🚀 Canary is running");
