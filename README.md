# Canary

Lightweight HTTP monitoring **and** push-alert hub built on [Deno Deploy](https://deno.com/deploy).

Canary polls your HTTP endpoints on a cron schedule, extracts numeric values from JSON responses, and fires SMS / email / [ntfy](https://ntfy.sh) alerts the moment a threshold is breached. It alerts again when it recovers. It also accepts **inbound webhooks** so other projects can push alerts through the same recipients — one alert hub for your whole stack.

---

## Features

- **Web dashboard + 3-step wizard** for creating monitors, configuring checks, and managing alert recipients & message templates
- **Duplicate a monitor**: one click clones an existing monitor's full check + alert config into the wizard, prefilled and named `(Copy of) …`, so a near-identical monitor is a couple of edits away (persisted only when you finish the wizard)
- **One-step integrations**: for a project that exposes the Canary health contract, `POST /integrations` (or the **+ Add integration** button) provisions monitor + secret + check + alert and runs an immediate verification check
- **Two alert sources, one pipeline**: cron-driven pull *or* webhook-driven push, both using the same recipients/templates/recovery logic
- **Flexible scheduling**: human-readable (every day at 9 AM weekdays) or raw cron expression
- **JSON metric extraction**: dot-notation path extraction from any JSON response
- **Threshold comparisons**: `gt`, `lt`, `gte`, `lte`, `eq`
- **Multi-channel alerts**: SMS via Zapier webhook, email via Postmark, or push via [ntfy.sh](https://ntfy.sh); mix recipients per monitor — up to **5 SMS numbers** per alert, sent 4 seconds apart
- **Message templating**: `{monitor}` `{status}` `{observed}` `{timestamp}` `{error}` `{logsUrl}` plus user-defined captures from the response — and a check's `error` is always appended to a custom message that doesn't already include it, so a transport/auth failure can't masquerade as a metric breach
- **Recovery notifications**: optional alert when a failing monitor returns to healthy
- **All-clear heartbeat**: optional per-check "notify on every run" — a healthy run sends an "all clear" (with the observed count and an optional `logsUrl` to click through) instead of silence. Email & ntfy only; SMS is skipped for all-clears so a heartbeat never texts you
- **Stateless HMAC auth**: admin + invited users, 24-hour sessions, no per-request DB lookup
- **Push webhooks**: per-monitor `cnry_v1_…` bearer secrets, hashed at rest, rotate/revoke from the UI
- **Secret management**: store API keys / bearer tokens in Deno KV and reference them in monitor headers as `{{KEY}}`
- **Manual trigger**: fire any monitor on demand via `POST /run/:monitorId`
- **Reports & failed-run drill-in**: per-monitor check history in the dashboard — click any failed run to see the exact request sent and the response received (secrets redacted, body truncated); resilient to an undeserializable KV row, which it surfaces for one-click purge instead of erroring
- **Structured leveled logs**: `LOG_LEVEL`-gated logging that stays quiet by default (a cold-start logs nothing) and tags every line of a single check run with `[run=<id>]` so its logs group together
- **Diagnostic snapshot**: `GET /api/debug` returns the full KV state — what monitors/checks/alerts/webhooks exist, last cron tick, env presence
- **Test-fire endpoint**: `POST /test-alert` sends one real SMS/email/ntfy push to verify creds without setting up a monitor
- **SMS Relays**: a push-driven monitor type — another project POSTs a raw `error` to `POST /relay/<monitorId>/fire` with a shared token in the body, and Canary forwards it straight to SMS (no check, no cron, no `cnry_v1_` header secret)
- **Deno Deploy usage digest**: a daily "here's what happened" report of org-wide requests, KV read/write units, egress, CPU and memory — **broken down per app**, busiest first, with dormant apps filtered out. Selectable window (`?day=yesterday`, an explicit `from`/`to`, or a rolling `?hours=`), timestamps rendered in Eastern time
- **Deno Deploy spend guardrail**: alerts at a percentage of your **real** usage-based spend against the **live** spend limit (raise the limit in Deno and the check follows), read from the console billing API
- **`internal:` check sources**: a check can name a producer Canary runs in-process instead of fetching a URL — which is what makes Canary able to monitor *itself* (a deployment can't HTTP-fetch its own hostname), with no bearer secret and no network hop
- **Zero dependencies**: plain Deno with no third-party frameworks

---

## Architecture

```
canary/
├── dist.rune/
│   ├── dto/            # Plain TypeScript interfaces
│   ├── pure/           # Side-effect-free logic (Schedule, Extractor, Comparator,
│   │                   #   time-window, deno-usage/deno-spend aggregation)
│   ├── impure/         # Deno KV domain classes + check sources + alert channels
│   │   ├── source/     #   http (fetch a URL) | internal (run a producer in-process)
│   │   └── _log.ts     # Central leveled logger (LOG_LEVEL + per-run [run=] tag)
│   └── integration/    # Orchestration functions (one per API operation)
├── main.ts             # Deno.serve routes + Deno.cron tick
├── canary.rune         # Rune spec (source of truth for requirements)
└── deno.json
```

**Sources:** a check's `url` selects how it is executed — an ordinary `http(s)://`
URL is fetched over the network, while an `internal:<producer>` URL runs a
producer inside the process (see [Deno Deploy usage & spend](#deno-deploy-usage--spend)).

**Persistence:** Deno KV
**SMS:** POST to a Zapier webhook → `{ "Number": "", "Message": "" }`
**Email:** [Postmark](https://postmarkapp.com) REST API

---

## Getting Started

### Prerequisites

- [Deno 2.x](https://deno.com) installed

### 1. Clone and configure

```bash
git clone https://github.com/WSAdam/canary.git
cd canary
```

Create a `.env` file in the project root:

```env
# Admin login (seeded on first boot — required to access the dashboard)
ADMIN_USERNAME=you@example.com
ADMIN_PASSWORD=changeme

# Alert delivery (each is only required if you actually use that channel)
ZAPIER_SMS_URL=https://hooks.zapier.com/hooks/catch/...
POSTMARK_SERVER_TOKEN=your-postmark-server-token
POSTMARK_FROM_EMAIL=alerts@yourdomain.com

# Deno Deploy usage digest + spend guardrail.
# NOTE: these use a DD_ prefix, not DENO_ — Deno Deploy RESERVES the `DENO_`
# namespace and rejects any env var it doesn't recognise ("Environment variable
# names starting with 'DENO_' are restricted except for allowed ones").
DD_ORG_TOKEN=ddo_...      # Deploy ORG access token (Settings → Access Tokens) — usage digest
DD_USAGE_SECRET=...       # bearer for the /api/deno-* HTTP routes (optional; unused by internal: checks)
DD_SESSION_TOKEN=ddw_...  # console session cookie value (the `token=ddw_…` cookie) — spend guardrail; EXPIRES
DD_ORG_ID=00000000-...    # your org's UUID (seen in the console billing request / lastOrgId cookie)
```

The four `DD_*` variables are only needed for the Deno Deploy usage digest and
spend guardrail — see [Deno Deploy usage & spend](#deno-deploy-usage--spend).
Everything else works without them.

### 2. Run locally

```bash
# Development (with file watching)
deno task dev

# Production
deno task start
```

### 3. Run tests

```bash
deno task test
```

### 4. Open the dashboard

Visit [http://localhost:8000](http://localhost:8000) and log in with the `ADMIN_USERNAME` / `ADMIN_PASSWORD` from your `.env`. The dashboard lets you create monitors (or **duplicate** an existing one), configure checks/alerts, invite teammates, manage webhook keys, and fire one-off test alerts — everything below is also doable via the API.

---

## API Reference

All routes return JSON. Every admin route requires `Authorization: Bearer <session-token>` (obtained from `POST /auth/login`). The webhook-fire route uses its own per-monitor bearer secret instead.

### Integrations (one-step setup)

The fastest way to monitor another project. If the project exposes the **Canary health contract**, a single call — or the dashboard's **+ Add integration** button — stands up the monitor, secret, check, and alert, then runs an immediate verification check so you know right away it's wired up.

**The health contract.** The project exposes `POST /canary/errors`, authenticated with a bearer secret, returning at least a numeric `totalErrors` for an ET calendar day (default: the previous full day):

```json
{ "ok": true, "timezone": "America/New_York", "date": "2026-06-02",
  "window": { "since": 1780372800000, "until": 1780459200000 },
  "totalErrors": 0, "findingIds": [], "errors": [] }
```

Canary reads the error count; **healthy = 0**. It resolves the count with the `$errors` sentinel, so a project that names the field `unrecoveredErrors` (or only returns an `errors[]` array) still monitors correctly — you don't have to match the exact field name. Because the shape is otherwise identical for every project, the check config is boilerplate — you supply only what varies.

**Producer side.** A Deno project can expose this endpoint in a few lines with the [`reporter/`](reporter/) drop-in — `await canary.trackError(step, msg)` to record, `canary.handleErrors(req)` to serve. See [reporter/README.md](reporter/README.md).

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/integrations` | Provision monitor + secret + check + alert in one call, then verify. |

```json
POST /integrations
{
  "name": "autobottom",
  "baseUrl": "https://autobottom.thetechgoose.deno.net",
  "secret": "<the project's CANARY_SECRET>",
  "recipients": [{ "channel": "ntfy", "address": "adam-code-alerts" }],
  "cron": "0 13 * * *"
}
```

`cron` is optional (defaults to a daily run ~09:00 ET, which reports the full previous ET day). Returns `{ monitorId, secretKey, firstRun }`. Behind the scenes the check is created as `POST <baseUrl>/canary/errors` with header `Authorization: Bearer {{<NAME>_CANARY_SECRET}}`, `expression: "$errors"` (resolves the error count whatever the field is named), pass-when-`≤ 0`, `notifyOnRecover: true`; the secret is stored under `<NAME>_CANARY_SECRET` (referenced via `{{…}}` substitution, never returned).

`firstRun` is the immediate verification run: if `firstRun.error` is set you have a **wiring problem** (unreachable / bad secret / wrong shape) to fix; otherwise `firstRun.passed` reflects the project's prior-day health.

Pull (not push) is deliberate — Canary polling the endpoint detects both reported errors **and** a down/unreachable project (a failed fetch alerts on its own), which push can't. Need a fully custom monitor? Use the 3-step **+ Add monitor** wizard or the `/monitors` → `/check` → `/alert` calls below.

---

### Auth & Users

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/login` | `{username, password}` → `{token}`. Sessions are stateless HMAC tokens, 24-hour TTL. |
| `POST` | `/auth/logout` | No-op (client clears the token). |
| `POST` | `/users` | Create a user (admin). |
| `GET`  | `/users` | List usernames (admin). |
| `DELETE` | `/users/:username` | Delete a user (admin). |
| `POST` | `/invites` | `{emails: [...]}` — sends invite links via Postmark; each recipient sets their own password on accept. |
| `GET`  | `/invite/info?token=...` | Public — returns the invite's email so the accept page can show who it's for. |
| `POST` | `/invite/accept` | Public — `{token, password}` consumes the invite, creates the user, returns a session token. |

`ADMIN_USERNAME` + `ADMIN_PASSWORD` are seeded into the user table on first boot (idempotent).

---

### Monitors

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/monitors` | Create a monitor |
| `GET` | `/monitors` | List all monitors |
| `GET` | `/monitors/:id` | Get a monitor |
| `PATCH` | `/monitors/:id` | Rename / edit a monitor's name + description |
| `DELETE` | `/monitors/:id` | Delete a monitor of **any** type and everything scoped to it (check, alert, webhook secret, relay config, run history). Named secrets are left intact. |

**Create a monitor**

```json
POST /monitors
{
  "name": "Production API",
  "description": "Watches the /health endpoint"
}
```

**Rename / edit** (partial body — omitted fields keep their current value; the
path id always wins over any `monitorId` in the body):

```json
PATCH /monitors/:id
{ "name": "Production API (v2)", "description": "Watches /healthz" }
```

Renaming onto a name another monitor already uses returns `409 duplicate-name`.

**Duplicate** (dashboard only): the **Duplicate** button on a monitor card opens
the create wizard prefilled with a full copy of the source's check + alert config
and the name pre-set to `(Copy of) <name>`. There's no dedicated duplicate
endpoint — it's a client-side convenience that re-runs the normal `POST /monitors`
→ `/check` → `/alert` sequence when you finish the wizard, so nothing is written
until then (and the incoming webhook, a per-monitor secret, is not copied).

---

### Check Configuration

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/monitors/:id/check` | Configure what to check |
| `GET` | `/monitors/:id/check` | Get check configuration |

**Configure a check**

```json
POST /monitors/:id/check
{
  "url": "https://api.example.com/health",
  "method": "GET",
  "headers": {},
  "expression": "data.responseTime",
  "comparatorOp": "lt",
  "threshold": 500,
  "cron": "*/5 * * * *",
  "notifyOnRecover": true,
  "notifyOnSuccess": false,
  "logsUrl": "https://dash.deno.com/projects/app/logs"
}
```

| Field | Description |
|-------|-------------|
| `url` | Usually an `http(s)://` URL to fetch. May instead be an **`internal:<producer>`** URL, which runs a producer inside Canary rather than over the network — required when monitoring Canary's own deployment, since Deno Deploy refuses a self-fetch with **508 Loop Detected**. See [Deno Deploy usage & spend](#deno-deploy-usage--spend). |
| `expression` | Dot-notation path into the JSON response body. Two robustness extras: list `\|`-separated fallbacks (`totalErrors\|unrecoveredErrors`) and the first that resolves to a number wins; or use the sentinel **`$errors`** to read the error count regardless of the producer's field name (known names like `totalErrors`/`unrecoveredErrors` → an `errors[]` array's length → a guarded fuzzy match, never a rate/threshold field). |
| `comparatorOp` | `gt`, `lt`, `gte`, `lte`, or `eq` |
| `threshold` | Numeric value to compare against |
| `cron` | Standard 5-field cron expression |
| `notifyOnRecover` | Send an alert when the monitor returns to healthy |
| `notifyOnSuccess` | Optional (default `false`). Alert on **every** run, not just failures — a healthy run sends an "all clear" with the observed count (e.g. "0 errors found"). Fires on the check's schedule, to email & ntfy recipients; **SMS is skipped for all-clears** so a heartbeat never texts you. Failures/recoveries are unaffected. |
| `logsUrl` | Optional http(s) link surfaced in every alert (e.g. the app's logs page) so a recipient can click through to verify. Shown in the default alert body; reference `{logsUrl}` to place it in a custom message template. |

---

### Alert Configuration

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/monitors/:id/alert` | Configure who to notify |
| `GET` | `/monitors/:id/alert` | Get alert configuration |

**Configure alerts**

```json
POST /monitors/:id/alert
{
  "recipients": [
    { "channel": "sms", "address": "+15555550100" },
    { "channel": "email", "address": "oncall@example.com" },
    { "channel": "ntfy", "address": "adam-code-alerts" }
  ]
}
```

Include up to **5** `sms` recipients per alert (add more numbers with the **+ Add number** button in the wizard). When the alert fires, the SMS sends are **staggered 4 seconds apart** — first immediate, each subsequent +4s — so a fan-out doesn't hammer the Zapier webhook; email and ntfy fire immediately. The same `smsMessage` template is sent to every number.

The `ntfy` address can be a bare topic name (`adam-code-alerts` → `https://ntfy.sh/adam-code-alerts`), `ntfy.sh/<topic>`, or a full URL to a self-hosted ntfy server. Failing checks send with `Priority: high` + `Tags: warning`; recoveries send with `Priority: default` + `Tags: white_check_mark`.

> **Custom templates always surface a failure's error.** A custom `smsMessage` / `emailMessage` / `ntfyMessage` is written for a metric breach, but a check can also fail for a transport reason (HTTP 401, timeout, extraction error) — where the metric was never measured. To stop such a failure from masquerading as a metric result, Canary appends the run's `error` to the rendered message whenever the message doesn't already include it (so a template that uses `{error}` isn't double-tagged). Reference `{error}` explicitly to place it yourself.

---

### Schedule Builder

Build a cron expression from a human-readable input:

```json
POST /schedule/build
{
  "frequency": "daily",
  "timeOfDay": "9:00 AM",
  "daysOfWeek": "weekdays"
}
```

```json
{ "cron": "0 9 * * 1-5" }
```

| `frequency` | Options |
|-------------|---------|
| `"hourly"` | Runs every hour; ignores `timeOfDay` and `daysOfWeek` |
| `"daily"` | Runs once per day at `timeOfDay` |
| `"once"` | Alias for `daily` |

| `daysOfWeek` | Value |
|--------------|-------|
| `"daily"` | Every day (`*`) |
| `"weekdays"` | Monday–Friday (`1-5`) |
| `"weekends"` | Saturday–Sunday (`0,6`) |

---

### Secrets

Store sensitive strings in Deno KV and reference them anywhere in a monitor's
check — URL, header values, or request body — as `{{KEY}}`. Values are injected
server-side just before the request is sent; they are never returned by the API,
written to run results, or printed to logs (logs strip the query string and any
resolved value is redacted from error text). Keys may contain letters, numbers,
and underscores. Manage them in the **Secrets** panel on the dashboard.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/secrets` | Set a secret (upsert) |
| `GET` | `/secrets` | List secret **keys** (never values) |
| `DELETE` | `/secrets/:key` | Delete a secret |

```json
POST /secrets
{ "secretKey": "MY_API_KEY", "secretValue": "sk-..." }
```

Reference a secret in the check's URL, headers, or body:

```json
"headers": { "Authorization": "Bearer {{MY_API_KEY}}" }
```

If a check references a secret that doesn't exist, the run fails with a clear
`secret-not-found` error (naming the key, never a value) — which, like any
failure, fires an alert.

---

### Manual Trigger

Fire a monitor immediately without waiting for its cron schedule:

```bash
POST /run/:monitorId
```

---

### Reports & run history

The dashboard's **Reports** tab lists recent fired checks per monitor (newest first) over a 24h / 7d / 30d window. Each **failed** run is clickable and opens a drill-in showing the exact request sent and response received — the fastest way to answer "what did the endpoint actually return?"

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/reports?window=24h\|7d\|30d` | Per-monitor run summary + recent rows (capped at 500/monitor). Each row includes `runId`, `passed`, `observed`, `error`, `captures`, and `hasDetail` (whether request/response was captured). Each monitor also carries a `corrupt[]` array (see below), usually empty. |
| `GET` | `/api/runs/:monitorId/:timestamp/:runId` | Full detail for a single run: `request` (method, url, redacted headers, body) and `response` (status, secret-redacted body, `truncated` flag). Captured on **failed runs only**. |
| `DELETE` | `/api/runs/:monitorId/:timestamp/:runId` | Purge a single run row by key (deletes the run **and** its `run_idx` sidecar). Deletes by key only — no read — so it works even on a row whose value can't be deserialized. |
| `POST` | `/api/reports/:monitorId/dismiss-corrupt` | Acknowledge an unrecoverable (pre-`run_idx`) corrupt row so its banner stops showing. Records `["run_corrupt_ack", monitorId]`; only suppresses legacy banners — purgeable rows keep their Purge. |

> Object/array captures are stored as JSON (e.g. `errors=[{"code":"X"}]`), not the old `[object Object]`. Request/response capture is forward-only — runs recorded before this was added have no detail.

**Corrupt-row resilience.** Run history is read one row at a time, so a single stored run value that fails to deserialize (a `RangeError` — e.g. a legacy oversized row) truncates only that monitor's history at the bad row instead of `500`-ing the whole tab. The offending row is surfaced in the report's `corrupt[]` and shown as a banner on the Reports tab: rows with an `exact` key (recovered from the `run_idx` sidecar written alongside every new run) get a **one-click Purge**; legacy rows written before the index show their timestamp bracket and a form to purge by the `runId` from the logs (and a **Dismiss** button when the key is unrecoverable). Purges call the `DELETE` endpoint above. The run path is hardened to match: a corrupt *newest* row no longer wedges a monitor's run/alert loop, and a failed run-history commit throws rather than logging a false success.

---

### Deno Deploy usage & spend

Two producers that report on the Deno Deploy **organization** itself: a daily
usage digest, and a guardrail on real dollar spend.

**Use them from a check via an `internal:` URL, not over HTTP.** A deployment
cannot HTTP-fetch its own hostname — Deno Deploy answers **508 Loop Detected** —
so a check pointed at Canary's own `/api/deno-*` route can never run. An
`internal:` URL runs the producer in-process instead: no network hop, no
`Authorization` header, no `DD_USAGE_SECRET`, and the data never leaves the
isolate. The wizard's **Test request** button resolves `internal:` URLs too. An
unknown producer name fails loudly at run time, listing the valid ones.

| Check URL | Equivalent HTTP route |
|-----------|----------------------|
| `internal:deno-usage?day=yesterday` | `GET /api/deno-usage?day=yesterday` |
| `internal:deno-spend` | `GET /api/deno-spend` |

The HTTP routes remain for **external** callers and are bearer-authed with
`DD_USAGE_SECRET` (503 if it isn't set).

#### Usage digest — `deno-usage`

Org-wide usage summed across every app: requests, KV read/write units, egress,
CPU and memory, plus a **per-app breakdown**. Reads the Deno Deploy **v2**
analytics API with `DD_ORG_TOKEN`. Per-app analytics are chunked to respect the
API's 7-day range cap; one app's failed call is counted in `appsErrored` rather
than blanking the digest.

Pick the window with exactly one of:

| Param | Window |
|-------|--------|
| `?day=yesterday` / `?day=today` | that whole calendar day, `00:00`–`23:59:59.999` Eastern (a day still in progress is clamped to now) |
| `?from=…&to=…` | an explicit range, both required |
| `?hours=N` | rolling N-hour window ending now — the default, `N=24` |

Add `?trailing=N` to any of them for a trailing N-day trend alongside the day's
own numbers (see below).

**Prefer `?day=` for a recurring check.** An absolute `from`/`to` is frozen, so a
daily digest would re-report the same date forever. `from`/`to` accept
`YYYY-MM-DD`, `"YYYY-MM-DD HH:MM"`, or a full ISO timestamp; a value carrying
**no zone is read as Eastern**, an explicit `Z`/offset is honoured as written.

```jsonc
{
  "ok": true,
  "window": {
    "since": "2026-07-19T04:00:00.000Z",   // UTC ISO — unambiguous, for machines
    "until": "2026-07-20T03:59:59.999Z",
    "hours": 24,
    "sinceLocal": "00:00 19/July/2026 EDT", // HH:MM DD/Month/YYYY TZ, Eastern
    "untilLocal": "23:59 19/July/2026 EDT",
    "label": "19/July/2026 00:00 → 23:59 EDT"  // capture this for an alert body
  },
  "apps": 23, "appsActive": 6, "appsIdle": 17, "appsErrored": 0,
  "requests": 21031, "kvReadUnits": 87199, "kvWriteUnits": 15105,
  "egressGB": 0.194, "cpuHours": 1.45, "memoryGBHours": 7.4,
  "byApp": [ { "app": "autobottom", "requests": 12345, "kvReadUnits": 54201,
               "kvWriteUnits": 8102, "egressGB": 0.12, "cpuHours": 0.9,
               "memoryGBHours": 4.1 } ],
  "breakdown": "autobottom  12,345 req  54,201 KVr  8,102 KVw\n+17 idle"
}
```

Apps with **no activity at all** (no requests, no KV reads, no KV writes) are
omitted from `byApp` — a row of zeroes is noise. Their count is kept as
`appsIdle`, and `breakdown` ends with a `+N idle` line. An app whose analytics
call failed carries `"errored": true`, so incomplete numbers can't read as a
genuine zero.

`breakdown` is `byApp` pre-rendered as a fixed-width text table, because a
capture on an array would render as raw JSON in an email.

##### Trailing trend — `?trailing=N`

Adds the `N` complete days ending with the reporting day (2–31), so the digest
carries both "yesterday" and "yesterday in context". The fetch window widens to
cover them and **both** the day's totals and the per-day series come from that
one pass — the trend costs no extra API calls.

```jsonc
"trailing": {
  "days": 7,
  "series": [ { "date": "2026-07-13", "label": "Mon 13/July", "requests": 14210, … } ],
  "comparison": {
    "requests":     { "vsPrevDay": 37.9, "vsAverage": 15.1 },
    "kvReadUnits":  { "vsPrevDay": 38.9, "vsAverage": 15.4 },
    "kvWriteUnits": { "vsPrevDay": 27.6, "vsAverage": 8.2 }
  },
  "table": "Day          Requests  KV reads …"
}
```

`series` is **oldest first**, so the most recent day reads last, next to the
totals. `vsAverage` compares the latest day against the average of the *preceding*
days only — including it in its own baseline would damp the deviation being
surfaced. Either figure is `null` where there's no meaningful baseline (no prior
day, or a previous value of 0 — "up from nothing" isn't a percentage), and
renders as `—`. A day with no traffic still gets a row, so a quiet day reads as a
zero rather than vanishing from the trend.

##### `report` — the whole email in one capture

Every digest carries a `report` string: the day's totals, the per-app breakdown,
and (when requested) the trailing trend, already laid out. Capture it once as
`{report}` instead of reproducing that layout in the alert template.

**As a daily report** — URL `internal:deno-usage?day=yesterday&trailing=7`,
`expression: requests`, `comparatorOp: gte`, `threshold: 0` (a condition that
always passes), `notifyOnSuccess: true`, and a single capture
`{ report: "report" }` with an email body of just `{report}`.

For a hand-built layout instead, capture the pieces —
`{ requests: "requests", kvReads: "kvReadUnits", kvWrites: "kvWriteUnits", window: "window.label", breakdown: "breakdown", trend: "trailing.table" }`
— or a single app by index, e.g. `byApp.0.requests`.

> Alert bodies are sent as plain text, so the fixed-width tables keep their
> newlines. Some mail clients render `text/plain` in a proportional font, which
> can soften the column alignment.

#### Spend guardrail — `deno-spend`

The org's real usage-based spend (`spendUSD`) against its **live** hard limit
(`limitUSD` — raise it in Deno and the check follows automatically),
`pctOfLimit`, the configured alert `thresholds`, and a per-dimension breakdown.

The public token API exposes usage but **not dollars**, so this reads the
console's internal billing API (tRPC) using a browser **session cookie**
(`DD_SESSION_TOKEN`) plus `DD_ORG_ID`. That interface is undocumented and the
cookie **expires**: on a rejected session it returns **401** so the monitor
alerts "refresh `DD_SESSION_TOKEN`" rather than silently reporting a stale or
zero number.

```jsonc
{
  "ok": true,
  "spendUSD": 300.0, "limitUSD": 400, "pctOfLimit": 75.0,
  "thresholds": [140, 180],
  "items": [ { "description": "KV Reads (units)", "costUSD": 112.5 } ],
  "asOf": "2026-07-20T15:45:00.000Z"
}
```

**As a guardrail** — URL `internal:deno-spend`, `expression: pctOfLimit`,
`comparatorOp: gte`, `threshold: 80`, `notifyOnRecover: true`, captures
`{ pct: "pctOfLimit", spend: "spendUSD", limit: "limitUSD" }`, hourly cron.

### Diagnostics

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | Public — `{ status, startedAt, lastCronTick, monitors: count }`. |
| `GET` | `/api/debug` | Admin — full KV snapshot: monitors, checks (with `matchesNow`), alerts (with channel list + custom-template flags), latest run per monitor, webhooks (existence + fingerprint), env-var presence booleans. The first place to look when "alerts aren't arriving." |

**Logs.** Server logs go through a central leveled logger gated by `LOG_LEVEL` (default `info`). At `info`, bootstrap and idle-cron chatter is suppressed — a Deno Deploy cold-start logs nothing — so only real activity (runs, alerts, warnings, errors) shows. Every line is prefixed `[level]`, and lines emitted inside a check run also carry `[run=<id>]` (matching the stored `runId`) so one run's logs group together even when isolates interleave. Set `LOG_LEVEL=debug` for the full firehose. Sensitive header values (Authorization, Cookie, …) are redacted before anything is logged.

---

### Test alert

Fire one real SMS / email / ntfy push without setting up a monitor — useful for confirming the underlying provider credentials work end-to-end.

```bash
POST /test-alert
{ "channel": "email", "address": "you@example.com" }
{ "channel": "sms",   "address": "15555550100" }
{ "channel": "ntfy",  "address": "adam-code-alerts" }
```

Optional fields per channel: `emailSubject`, `emailMessage`, `smsMessage`, `ntfyTitle`, `ntfyMessage` (same `{var}` templating as the saved monitor alerts).

---

### Push Alerts (Webhooks)

Let other projects push alerts into a monitor with a per-monitor bearer secret. Canary verifies the secret, writes a run result, and dispatches alerts through the same SMS/email/ntfy recipients configured on the Configuration tab — same recovery semantics as cron.

**Generate a key** (admin, in the dashboard or via API):

```bash
curl -X POST $URL/monitors/$MID/webhook -H "Authorization: Bearer $ADMIN_TOKEN"
# { "secret": "cnry_v1_...", "fingerprint": "cnry_v1_abcd", "createdAt": "...", "warning": "..." }
```

The plaintext is shown **exactly once**. Save it. Rotating generates a new one; the old one immediately stops working.

**Fire an alert** (from another project):

```bash
curl -X POST $URL/webhook/$MID/fire \
  -H "Authorization: Bearer cnry_v1_..." \
  -H "Content-Type: application/json" \
  -d '{
    "passed": false,
    "observed": 0,
    "error": "Stripe webhook handler 500",
    "captures": { "service": "payments-link", "env": "prod" }
  }'
# { "runId": "...", "fired": true, "channels": ["sms","ntfy"] }
```

All body fields are optional:

| Field | Type | Default | Effect |
|-------|------|---------|--------|
| `passed` | boolean | `false` | `false` fires a failure alert; `true` fires a recovery alert (only when prior run was a failure and the monitor's `notifyOnRecover` is true) |
| `observed` | number | `0` | Surfaced as `{observed}` in templates |
| `error` | string | — | Surfaced as `{error}` and in the default body |
| `captures` | object | — | Merged into the `{var}` table for template expansion (e.g. `{service}`) |
| `message` | string | — | Overrides every channel's message template for this fire only |
| `title` | string | — | Overrides ntfy title / email subject for this fire only |

**Management:**

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/monitors/:id/webhook` | Generate or rotate (returns plaintext once) |
| `GET`  | `/monitors/:id/webhook` | Returns `{ exists, fingerprint, createdAt }` |
| `DELETE` | `/monitors/:id/webhook` | Revoke |

**Security notes:**

- Secrets are stored hashed (SHA-256). The plaintext cannot be recovered — only rotated.
- Rotation is the response to leakage. There is no rate limiting in v1, so a leaked secret can be used to fire arbitrary alerts until rotated.
- The `cnry_v1_` prefix makes leaked keys easy to grep for in logs and git history.

---

### SMS Relays (push a raw error → SMS)

A **relay** is a **monitor of type `relay`**: instead of polling an endpoint on a schedule, it *receives* a push. Another project POSTs a raw `error` to its fire URL and Canary forwards it straight to the relay's SMS numbers — no check, no cron, no `cnry_v1_` header secret. Authentication is a shared token you choose, sent as `Authorization: Bearer <token>` (or, equivalently, in the JSON body as `test`).

This is the inbound direction: **your project posts failures to Canary, and Canary texts them.** (The opposite direction — Canary polling your project for its error count — is an [integration](#integrations-one-step-setup).) A relay shows up in the monitor list (with a **RELAY** badge) and in **Reports** like any other monitor.

Create one with the dashboard's **+ Add relay** button, or in one API call:

```json
POST /relays
{
  "name": "payments-sms",
  "numbers": ["18432222986", "18435551234"],
  "token": "a-long-high-entropy-shared-secret",
  "template": "🚨 {monitor}: {error}"
}
// → { "monitorId": "…", "name": "payments-sms" }
```

This provisions a `type: "relay"` monitor plus its config. `name` is the monitor's display name; `numbers` is 1–5 entries of 10 or 11 digits each; `token` is ≥ 16 characters (a machine-to-machine secret, stored as an unsalted SHA-256 hash — prefer a long, high-entropy value). The token is never returned.

**Fire it** (from your project — Bearer-token auth, URL keyed by `monitorId`):

```bash
curl -X POST $URL/relay/$MONITOR_ID/fire \
  -H 'Authorization: Bearer a-long-high-entropy-shared-secret' \
  -H 'Content-Type: application/json' \
  -d '{
    "error": "ODR injection failed: …",
    "source": "sms-bot", "kind": "injection-failure",
    "phone": "6142967343", "attempts": 5, "ts": "2026-06-30T14:00:00Z"
  }'
# { "runId": "...", "fired": true, "channels": ["sms"] }
```

**Any extra top-level field** you send (`source`, `kind`, `phone`, `attempts`, `ts`, …) is folded into the run's **captures** — preserved in Reports and usable as a `{var}` in the SMS template (e.g. `template: "{kind}: {error} ({phone}, {attempts}x)"`). So a structured failure payload needs no nesting under `captures`. All fields except the token are optional:

| Field | Type | Default | Effect |
|-------|------|---------|--------|
| `Authorization: Bearer` / `test` | string | — (required) | The shared token (header preferred; `test` body field also accepted). A missing/wrong token → `401`. |
| `error` | string | — | Surfaced as `{error}` and in the default SMS body. |
| `observed` | number | `0` | Surfaced as `{observed}`. |
| `captures` | object | — | Explicit `{var}` map; merged with (and wins over) the extra top-level fields above. |
| `message` | string | — | Overrides the relay's saved template for this fire only; `{var}` tokens still expand. |
| *(any other field)* | — | — | Folded into captures (string-coerced) — surfaced in Reports and as a `{var}`. |

The SMS body is the per-fire `message` (else the relay's saved `template`, else a default `Canary FAILED: <name> — error: … at <timestamp>`), expanded with `{monitor}` (the relay's name), `{error}`, `{observed}`, `{timestamp}`, `{status}`, plus any `captures`. Multiple numbers fan out staggered `SMS_STAGGER_MS` apart (default 4s), same as monitor alerts. Every fire is persisted as a run under the relay's `monitorId` and shows in **Reports** with the usual drill-in.

**Management** (admin — dashboard or API):

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/relays` | Provision a relay monitor (monitor + config) in one call. |
| `GET`  | `/monitors/:id/relay` | Read the relay config (numbers + template presence; **never** the token). |
| `POST` | `/monitors/:id/relay` | Reconfigure (numbers/template, and `token` to rotate — omit `token` to keep the current one). |
| `DELETE` | `/monitors/:id` | Delete the relay monitor entirely (record, token, run history). The dashboard's **Delete** button uses this; `DELETE /relays/:id` is a type-guarded alias. |

Relays send over the same `ZAPIER_SMS_URL` Zapier webhook as monitor SMS alerts — no extra env var. A relay's fire URL is shown under **Edit relay** any time after creation.

> **Security note** (same posture as webhook-fire): the fire route is public, authenticated only by the body token, and **not rate-limited in v1** — a leaked token can fire arbitrary SMS until you rotate it (`POST /monitors/:id/relay` with a new `token`). Use a long random token and rotate on any suspected leak.

---

## Verifying it works

Run these against your deployed URL (or `http://localhost:8000` locally) to confirm the full alert pipeline is wired up. Replace `$URL`, `$USER`, `$PASS` accordingly.

```bash
# 1. Log in and grab a session token
TOKEN=$(curl -s -X POST $URL/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" | jq -r .token)

# 2. Confirm Postmark creds (sends a real email)
curl -s -X POST $URL/test-alert \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"channel":"email","address":"you@example.com"}'

# 3. Confirm Zapier creds (sends a real SMS)
curl -s -X POST $URL/test-alert \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"channel":"sms","address":"+15555550100"}'

# 4. Snapshot KV state — what monitors/checks/alerts exist, env presence, last cron tick
curl -s $URL/api/debug -H "Authorization: Bearer $TOKEN" | jq
```

If `checks: []` in step 4, no monitor is wired to a check yet — that's why the cron tick fires with nothing to do. Configure one:

```bash
# Create a monitor that's guaranteed to fail (1 < 0 is false → comparator fails → alert)
MID=$(curl -s -X POST $URL/monitors \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Test","description":"deliberately failing"}' | jq -r .monitorId)

curl -s -X POST $URL/monitors/$MID/check \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://httpbin.org/json","method":"GET","headers":{},"expression":"slideshow.slides.length","comparatorOp":"lt","threshold":0,"cron":"* * * * *","notifyOnRecover":true}'

curl -s -X POST $URL/monitors/$MID/alert \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"recipients":[{"channel":"email","address":"you@example.com"}]}'
```

Wait one minute, then re-fetch `/api/debug`. `latestRuns[*].passed` for the smoke-test monitor should be `false`, and an alert email should land. To trigger immediately without waiting, `POST /run/$MID`.

In Deno Deploy logs, you should see exactly one `🔍 cron tick:` per minute followed by `⏰ scheduling run for monitor: ...` and `📧 email.send: ...`.

---

## Deploying to Deno Deploy

1. Push this repository to GitHub
2. Create a new project at [dash.deno.com](https://dash.deno.com)
3. Set the entrypoint to `main.ts`
4. Add environment variables in the project settings:
   - `ADMIN_USERNAME` + `ADMIN_PASSWORD` (required — seeds the admin user on first boot)
   - `POSTMARK_SERVER_TOKEN` + `POSTMARK_FROM_EMAIL` (for email alerts and invite emails)
   - `ZAPIER_SMS_URL` (for SMS alerts)
   - `DD_ORG_TOKEN` (only for the Deno usage digest)
   - `DD_SESSION_TOKEN` + `DD_ORG_ID` (only for the Deno spend guardrail)
   - `DD_USAGE_SECRET` (only to expose the `/api/deno-*` routes to external
     callers — `internal:` checks don't need it)

   Note the `DD_` prefix: Deno Deploy **rejects** unrecognised `DENO_*` names.

Deno Deploy provides Deno KV out of the box. No additional database setup required.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ADMIN_USERNAME` | Yes | Seeded into the user table on first boot; used to log into the dashboard. |
| `ADMIN_PASSWORD` | Yes | Seeded with the admin user (dashboard login). |
| `POSTMARK_SERVER_TOKEN` | For email alerts + invites | Postmark server API token. |
| `POSTMARK_FROM_EMAIL` | For email alerts + invites | Verified sender address. |
| `ZAPIER_SMS_URL` | For SMS alerts | Zapier webhook URL that forwards to Textmagic (or your SMS provider). |
| `FETCH_TIMEOUT_MS` | No (default `10000`) | Per-check request timeout in milliseconds. A check exceeding it fails with a `timed-out` error (which alerts). |
| `LOG_LEVEL` | No (default `info`) | Minimum log level to emit: `debug`, `info`, `warn`, or `error`. At `info`, bootstrap/idle-cron chatter is suppressed (a cold-start logs nothing) and only real activity — runs, alerts, warnings, errors — shows. Set `debug` for the full firehose. Each line is tagged `[level]`, and lines inside a check run also carry `[run=<id>]` (matching the stored run's `runId`) so one run's logs group together. |
| `ALLOW_PRIVATE_FETCH` | No (default off) | SSRF guard escape hatch. By default the check runner and the `/test-request` proxy refuse to fetch loopback/link-local/private/cloud-metadata hosts. Set to `1` to allow them — only when intentionally monitoring an internal service on a trusted private network. |
| `SMS_STAGGER_MS` | No (default `4000`) | Delay between consecutive SMS sends when an alert/relay fans out to multiple numbers (first immediate, each subsequent +Δ), throttling the Zapier webhook. Lower it for a faster provider, or `0` to send all at once. |
| `DD_ORG_TOKEN` | For the Deno usage digest | Deno Deploy **organization** access token (`ddo_…`, from the Deploy dashboard → Settings → Access Tokens). Reads the v2 analytics API. Note this is *not* the same as a deploy key such as `DD_API_KEY`. |
| `DD_SESSION_TOKEN` | For the Deno spend guardrail | The Deno **console session cookie** value (the `token=ddw_…` cookie). Reads real dollars from the console's internal billing API. **Expires** — a rejected session makes the check fail loudly rather than report a stale number. |
| `DD_ORG_ID` | For the Deno spend guardrail | Your Deno organization's UUID. |
| `DD_USAGE_SECRET` | No | Bearer required by the public `/api/deno-usage` and `/api/deno-spend` HTTP routes. Unset leaves those routes returning 503; **`internal:` checks don't need it** and are the recommended way to use these. |

> **Why `DD_` and not `DENO_`:** Deno Deploy reserves the `DENO_` namespace and
> rejects any variable in it that it doesn't itself define ("Environment variable
> names starting with 'DENO_' are restricted except for allowed ones"), so these
> follow the `DD_` prefix instead. Don't "tidy" them back.

ntfy doesn't need any env vars — the topic is configured per-recipient on each monitor.

> **Password policy:** dashboard/account passwords must be at least 8 characters (enforced server-side on user creation and invite acceptance).

**Session signing key:** the HMAC key that signs login sessions is generated
automatically on first boot and stored in Deno KV (`["config", "session-signing-key"]`).
No env var is required, and there is no predictable fallback. Deleting that KV
entry rotates the key and invalidates every live session (a clean "log everyone out").

---

## License

MIT
