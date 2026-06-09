# Changelog

All notable changes to Canary are documented here. The project is not formally
versioned yet, so entries are grouped by date. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/).

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
