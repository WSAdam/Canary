# Canary — Project Context

Orientation doc for anyone (human or agent) picking up this codebase. For setup,
the full API reference, and env vars, see [README.md](README.md). For the
formal requirements spec, see [canary.rune](canary.rune).

## What it is

Canary is a lightweight **HTTP monitoring + push-alert hub** running on
[Deno Deploy](https://deno.com/deploy). It polls HTTP endpoints on a cron
schedule, extracts a numeric value from the JSON response, compares it against a
threshold, and fires SMS / email / [ntfy](https://ntfy.sh) alerts when a check
fails (and again when it recovers). It also accepts **inbound webhooks** so other
projects can push alerts through the same recipients — one alert hub for the
whole stack.

- **Live:** https://canary.thetechgoose.deno.net
- **Repo:** github.com/WSAdam/Canary — deploys from `master` (push to `master` ships).

## Runtime & stack

- **Deno** (no third-party frameworks). `Deno.serve` for HTTP, `Deno.cron` for the
  per-minute tick, **Deno KV** for all persistence.
- **Frontend** is a single-file vanilla SPA embedded as the `INDEX_HTML` template
  literal inside [main.ts](main.ts) — no build step, no framework.
- Requires the `--unstable-kv --unstable-cron` flags (see `deno.json` tasks).

## Layout

```
main.ts          # Deno.serve routes + Deno.cron tick + the entire SPA (INDEX_HTML)
canary.rune      # Rune spec — requirements source of truth (loosely kept in sync)
dist.rune/       # Hand-maintained, test-covered implementation (NOT codegen)
  dto/           # Plain TS interfaces (+ _shared.ts: CanaryError)
  pure/          # Side-effect-free logic: Schedule, Extractor, Comparator
  impure/        # Deno KV domain classes, HTTP source, alert channels
    _kv.ts       # Deno.openKv() singleton
    _log.ts      # Central leveled logger (see Conventions)
  integration/   # Orchestration, one fn per API operation (runner-execute, …)
```

> `dist.rune/` is the real source — committed and tested via `deno test dist.rune/`.
> It is *not* generated from `canary.rune`; the spec is a higher-level artifact
> that has drifted, so the code is the source of truth. Update the spec when it's
> cheap, but don't treat it as a gate.

## Core flow (a check run)

`Deno.cron` tick (every minute, with cross-isolate KV locks for dedup) →
`executeRunner` ([runner-execute.ts](dist.rune/integration/runner-execute/runner-execute.ts)):
load check config → resolve `{{SECRET}}` refs → HTTP fetch → `Extractor.apply`
(numeric observed value) → `Comparator.evaluate` (pass/fail) → `Extractor.applyCaptures`
→ `persistRunAndAlert` (save `RunResultDto` to KV, then alert on failure/recovery).

- **Run history** is keyed `["run", monitorId, timestamp, runId]`.
- **Alert channels** ([impure/alertChannel](dist.rune/impure/alertChannel)): `email`
  (Postmark), `sms` (Zapier webhook), `ntfy`. `Promise.allSettled` — one channel
  failing never blocks the others.
- **Auth:** stateless HMAC session tokens (key auto-generated into KV on first
  boot); admin seeded from `ADMIN_USERNAME`/`ADMIN_PASSWORD`.
- **Inbound webhooks:** `POST /webhook/:monitorId/fire` with a per-monitor
  `cnry_v1_…` bearer secret (hashed at rest).

## Conventions (important)

- **Logging:** all server-side logging goes through the central logger
  `dist.rune/impure/_log.ts` — **never raw `console.*`** on the server side.
  (Browser `console.*` inside the `INDEX_HTML` string is fine — the logger is
  server-only.) `LOG_LEVEL` (default `info`) gates output; bootstrap/idle-cron
  chatter is `debug` so a cold-start logs nothing. Lines render `[level]` and,
  inside a run, `[run=<short8>]` via `withRun(runId, fn)` (AsyncLocalStorage) — the
  same id is the stored `runId`. Redact sensitive headers with `redactHeaders()`
  before logging or persisting any request.
- **Secrets never hit logs or history in the clear.** `{{KEY}}` templates stay
  unresolved in logs; `redactSecrets()` scrubs resolved values from errors and
  captured response bodies; `redactHeaders()` masks Authorization/Cookie/etc.
- **Failed-run drill-in:** failed runs persist a redacted, 16KB-truncated
  request/response on `RunResultDto`; the Reports tab makes failed rows clickable
  (`GET /api/runs/:monitorId/:timestamp/:runId`). Passing runs store no detail.
  Capture serialization uses JSON for objects/arrays (not `String()` →
  `[object Object]`).
- **Style:** TypeScript strict; emoji log prefixes (🚀 start, ✅ success, ❌ error,
  ⚠️ warn, 🔍 debug/search); fail-safe pattern (secondary failures never block the
  primary operation). **Never** create `.env.*` template files — document env vars
  in the README.

## Commands

```bash
deno task dev      # run locally with file watching
deno task start    # run locally (production flags)
deno task test     # deno test dist.rune/
deno task check    # type-check main.ts + e2e.ts
```

## Current state (2026-06-03)

Recently landed (commit `d20aa19`): central leveled logging with per-run
correlation, the `[object Object]` capture-serialization fix, and the failed-run
request/response drill-in. See [CHANGELOG.md](CHANGELOG.md).
