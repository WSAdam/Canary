# Changelog

All notable changes to Canary are documented here. The project is not formally
versioned yet, so entries are grouped by date. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/).

## 2026-06-24

### Added
- **Full captures in the run-detail drill-in.** The Reports run-detail modal now
  renders every capture in full (JSON pretty-printed when the value parses),
  with a Copy button, and **any run with captures is now drillable** — not just
  failed runs — so the truncated `errors=[…]` shown in a row can be read in full.
- **Delete an alert.** Each monitor card has a **Delete alert** button backed by a
  new idempotent `DELETE /monitors/:id/alert` (`alert.delete`); the monitor keeps
  running but stops notifying until an alert is re-added.

### Security
- **SSRF guard on every outbound fetch.** The check runner and the `/test-request`
  proxy now refuse loopback/link-local/private/cloud-metadata hosts (including
  IPv4-mapped IPv6 and NAT64 forms), follow redirects manually re-validating each
  hop, and strip `Authorization`/`Cookie` on cross-origin redirects. Opt out for a
  trusted internal target with `ALLOW_PRIVATE_FETCH=1` (see README). Residual
  DNS-rebinding risk is documented in `assertFetchableUrl`.
- **Deleting a user revokes their session immediately.** `validateSession` now
  confirms the account still exists, so a stateless token can't outlive a
  `DELETE /users/:username` by up to its 24h TTL.
- **Server-side password policy** (min 8 chars) enforced on user creation and
  invite acceptance — the API no longer trusts the SPA's client-side check.
- **Stored-XSS fix.** A check `expression` was rendered unescaped into the Reports
  comparator-hint; all user/server-controlled values now route through `esc()`.
- Output/secret hardening: capture values are now secret-redacted before persist
  and alert; alert-channel send failures map upstream 4xx → 400 (not a misleading
  500).

### Fixed
- **Run rows can no longer silently overflow KV.** Size caps are now byte-accurate
  (UTF-8, not UTF-16 code units) and enforced at the shared persistence chokepoint
  (`persistRunAndAlert`), so an oversized row from the cron runner **or** the
  webhook-fire path is trimmed to fit instead of throwing on save and vanishing
  from history. `request.url`/`headers` and the error message are bounded too.
- **Stepped cron fields now fire.** A field like `5/15` (`N/step`, no range end)
  validated but never matched, so the monitor silently never ran.
- **`comparatorOp` is validated at configure time** (allow-list), so a typo is
  rejected at save instead of false-alerting on every tick.
- **Invite acceptance is robust.** The token is consumed only *after* the account
  is created and logged in (peek-then-consume), so a failed accept no longer burns
  the invite; batch invite sends report per-recipient success/failure.
- **Alert dispatch truthfulness.** An alert whose recipients are all unknown
  channels no longer reports `fired:true` while sending nothing.
- Many malformed-input paths that returned `500` now return a proper `400`
  (login, users, monitors, checks, alerts, secrets, webhook bodies, path params),
  and integration provisioning no longer collides/overwrites or rolls back another
  integration's live secret.

### Changed
- **Removed the per-username login throttle.** A lockout keyed solely on the
  attacker-supplied username (gated before the credential check) let an
  unauthenticated caller lock out any user and break invite acceptance — a broken
  control worse than none. Brute-force protection will be reconsidered as a
  deliberate per-IP design.

### Docs
- Documented `ALLOW_PRIVATE_FETCH` and the password policy in the README.

## 2026-06-09

### Added
- **Duplicate a monitor.** Each monitor card now has a **Duplicate** button that
  opens the create wizard prefilled with a full copy of the source's check + alert
  config, with the name pre-set to `(Copy of) <name>` and the cursor at the start
  for an immediate retype. There's no dedicated endpoint — it reuses the normal
  create flow (`POST /monitors` → `/check` → `/alert`) and the existing
  `prefillCheck`/`prefillAlert` helpers, so the clone is persisted only when the
  wizard is completed and an abandoned copy leaves nothing behind (there is no
  `DELETE /monitors`). The incoming webhook (a per-monitor secret) is not copied.
- **Multiple SMS numbers per alert.** An alert can now notify up to **5** phone
  numbers. The wizard's SMS section has a **+ Add number** button (rows capped at
  5); when an alert fires, the SMS sends are **staggered 4 seconds apart** (first
  immediate, each subsequent +4s) so a fan-out doesn't hammer the Zapier webhook —
  email and ntfy still fire immediately. No storage change: recipients were
  already an array, so additional `{ channel: "sms" }` entries just work.
- **Monitor rename / edit.** `PATCH /monitors/:id` updates a monitor's name and
  description, with the name-uniqueness index moved atomically (rename onto a
  taken name → `409`). Editable from the dashboard via the wizard's edit-details
  mode.
- **Response body in failure-alert emails.** Failure emails now include the
  (secret-redacted, truncated) response body so you can triage without opening the
  dashboard.
- **In-page purge of corrupt run rows.** The Reports tab now surfaces any run row
  whose stored value can't be deserialized and offers a purge action — one-click
  when the exact key is known, or a paste-the-`runId` form for legacy rows. Backed
  by a new `DELETE /api/runs/:monitorId/:timestamp/:runId` (deletes by key, so it
  works on an unreadable row) and a tiny `["run_idx", monitorId, timestamp, runId]`
  sidecar written atomically with each run to keep keys recoverable.
- **Dismiss for unrecoverable legacy corrupt rows.** A pre-`run_idx` corrupt row
  has no sidecar, so its exact key can't be recovered and Deno KV can't delete it.
  The legacy banner now offers a **Dismiss warning** button backed by
  `POST /api/reports/:monitorId/dismiss-corrupt`, which records an ack at
  `["run_corrupt_ack", monitorId]` so the Reports scan stops surfacing that
  unactionable banner. Genuinely purgeable (indexed) rows are never hidden — they
  always keep their one-click Purge.

### Changed
- **Run-history scan / purge / dismiss moved into `RunResult`.** The Reports
  window walk, the corrupt-row delete-by-key, and the dismiss ack/check now live as
  `RunResult.scanWindow` / `.purge` / `.dismissCorrupt` (the `main.ts` route handlers
  are thin callers), so they sit in the tested `dist.rune` layer instead of inline in
  the request handler. Added coverage for the scan's per-row batching + `run_idx` key
  recovery + dismiss suppression, delete-by-key idempotency, the dismiss round-trip,
  the `save` commit guard, and `validateSession` (the auth gate the new routes
  inherit).

### Fixed
- **A dropped run-history write is no longer logged as a success.** `RunResult.save`
  ignored the atomic `commit()` result, so a rejected commit (neither the `run` row
  nor its `run_idx` sidecar landing) still emitted a `✅ saved` log — silently
  skewing history and manufacturing the exact missing-sidecar / legacy-orphan state
  the resilience work guards against. `save` now checks `ok` and throws, so the caller
  surfaces the failure instead of logging a false success.
- **A corrupt newest run row no longer wedges a monitor.** `persistRunAndAlert`
  reads the previous run via `RunResult.getLatest` before saving; that read walked
  the newest row and threw (`RangeError`) if its value couldn't deserialize, so the
  run aborted before persisting. With the bad row stuck as the newest, every
  subsequent run repeated the throw — the monitor silently stopped recording and
  alerting. `getLatest` now swallows an undeserializable newest row and reports "no
  previous run", so the run still persists a fresh readable+indexed row that
  un-blocks the monitor. (The `saved` log line also now includes the run
  `timestamp` so a row's full key is recoverable from the logs.)
- **Reports tab no longer dies on one bad row.** `GET /api/reports` walked each
  monitor's history with `kv.list` and `500`'d entirely if a single stored run
  value failed to deserialize (`RangeError`). It now reads runs one row at a time
  (`batchSize: 1`), so a corrupt row truncates only that monitor's history at the
  bad row — the rest of the dashboard loads.
- **Partial-PATCH clobber.** `Monitor.update` rebuilt the record from scratch, so
  a partial body (e.g. description only) wrote `undefined` into the omitted field.
  It now merges over the existing record (true PATCH semantics) and survives
  future `MonitorDto` fields.
- **Listening log noise.** Deno Deploy reprinted `Listening on …` on every isolate
  spin-up. `Deno.serve`'s `onListen` now routes that line through the logger at
  `debug`, so it's silent at the default `info` level.

## 2026-06-03

### Added
- **One-step integrations.** New `POST /integrations` endpoint and a dashboard
  **+ Add integration** button provision a full health-check monitor (monitor +
  secret + check + alert) in a single call against any project that exposes the
  Canary health contract (`POST /canary/errors → { totalErrors }`). The check is
  standardized — poll the endpoint, healthy when `totalErrors ≤ 0`, alert when it
  rises or the endpoint is unreachable — so you supply only name, base URL,
  secret, and recipients. Provisioning fires an immediate verification run
  (returned as `firstRun`) so wiring problems surface instantly, and a partial
  failure rolls back. New orchestrator
  `dist.rune/integration/integration-create/integration-create.ts`; see the
  README "Integrations (one-step setup)" section.
- **`reporter/` drop-in module.** The producer side of the health contract for
  Deno projects. `new CanaryReporter({ secret })` provides `trackError(step,
  msg)` to record errors and `handleErrors(req)` to serve `POST /canary/errors`
  — Deno KV by default (pluggable store), DST-correct calendar-day window,
  fail-safe recording. A new project can conform to the contract in a few lines
  instead of hand-building it. Tests + runnable example included; see
  `reporter/README.md`.
- **Structured leveled logging** (`dist.rune/impure/_log.ts`). All server-side
  logging now flows through a central logger gated by the `LOG_LEVEL` env var
  (default `info`). Bootstrap and idle-cron chatter is demoted to `debug`, so a
  Deno Deploy cold-start logs nothing at the default level — only real activity
  (runs, alerts, warnings, errors) shows.
- **Per-run log correlation.** Every line emitted inside a check run is tagged
  `[run=<id>]` (matching the stored `runId`) via an `AsyncLocalStorage` context,
  so one run's logs group together even when isolates interleave.
- **Failed-run drill-in.** Failed runs now persist the request (method, url,
  redacted headers, body) and response (status, redacted + 16KB-truncated body).
  New endpoint `GET /api/runs/:monitorId/:timestamp/:runId` returns a single
  run's full detail, and failed rows in the Reports tab are clickable — open a
  modal showing the exact request sent and response received. `/api/reports`
  rows now include `runId` and `hasDetail`.

### Fixed
- **`[object Object]` captures.** `Extractor.applyCaptures` coerced every value
  with `String()`, turning captured arrays/objects into the literal
  `"[object Object]"`. They are now JSON-serialized (e.g.
  `errors=[{"code":"X"}]`). Forward-only — runs recorded before this fix keep the
  old value.

### Security
- **Stopped a secret leak in logs.** The `POST /monitors/:id/check` handler was
  logging the full request body, including a plaintext `Authorization: Bearer`
  header. Sensitive header values (Authorization, Cookie, X-Api-Key,
  Proxy-Authorization) are now redacted everywhere they could be logged or
  persisted, via a shared `redactHeaders()`.

### Docs
- Documented `LOG_LEVEL`, the Reports/run-history endpoints, and the logging
  model in the README; added `context.md`; synced `canary.rune`
  (`ResponseDto.status`, `RunResultDto` request/response).

## 2026-06-02

### Added
- **Reports tab** — per-monitor check history (24h / 7d / 30d windows) in the
  dashboard, backed by `GET /api/reports`.

### Fixed
- SMS phone-number validation was blocking an alert from being re-saved.
- Assorted bug-screen fixes; wired up secret storage/reference end to end.

## 2026-06-01

### Added
- **Push-alert webhooks** — external projects can fire alerts through Canary's
  recipients via `POST /webhook/:monitorId/fire` using a per-monitor
  `cnry_v1_…` bearer secret (hashed at rest, rotate/revoke from the UI).
- Clickable variable chips on all alert message fields.

### Fixed
- Stop browsers caching the SPA HTML.
- Stop blocking save on orphaned alert customizations.
