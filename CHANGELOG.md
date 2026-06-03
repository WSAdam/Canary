# Changelog

All notable changes to Canary are documented here. The project is not formally
versioned yet, so entries are grouped by date. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/).

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
