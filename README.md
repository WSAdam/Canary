# Canary

Lightweight HTTP monitoring **and** push-alert hub built on [Deno Deploy](https://deno.com/deploy).

Canary polls your HTTP endpoints on a cron schedule, extracts numeric values from JSON responses, and fires SMS / email / [ntfy](https://ntfy.sh) alerts the moment a threshold is breached. It alerts again when it recovers. It also accepts **inbound webhooks** so other projects can push alerts through the same recipients — one alert hub for your whole stack.

---

## Features

- **Web dashboard + 3-step wizard** for creating monitors, configuring checks, and managing alert recipients & message templates
- **Two alert sources, one pipeline**: cron-driven pull *or* webhook-driven push, both using the same recipients/templates/recovery logic
- **Flexible scheduling**: human-readable (every day at 9 AM weekdays) or raw cron expression
- **JSON metric extraction**: dot-notation path extraction from any JSON response
- **Threshold comparisons**: `gt`, `lt`, `gte`, `lte`, `eq`
- **Multi-channel alerts**: SMS via Zapier webhook, email via Postmark, or push via [ntfy.sh](https://ntfy.sh); mix recipients per monitor
- **Message templating**: `{monitor}` `{status}` `{observed}` `{timestamp}` plus user-defined captures from the response
- **Recovery notifications**: optional alert when a failing monitor returns to healthy
- **Stateless HMAC auth**: admin + invited users, 24-hour sessions, no per-request DB lookup
- **Push webhooks**: per-monitor `cnry_v1_…` bearer secrets, hashed at rest, rotate/revoke from the UI
- **Secret management**: store API keys / bearer tokens in Deno KV and reference them in monitor headers as `{{KEY}}`
- **Manual trigger**: fire any monitor on demand via `POST /run/:monitorId`
- **Diagnostic snapshot**: `GET /api/debug` returns the full KV state — what monitors/checks/alerts/webhooks exist, last cron tick, env presence
- **Test-fire endpoint**: `POST /test-alert` sends one real SMS/email/ntfy push to verify creds without setting up a monitor
- **Zero dependencies**: plain Deno with no third-party frameworks

---

## Architecture

```
canary/
├── dist.rune/
│   ├── dto/            # Plain TypeScript interfaces
│   ├── pure/           # Side-effect-free logic (Schedule, Extractor, Comparator)
│   ├── impure/         # Deno KV domain classes + HTTP source + alert channels
│   └── integration/    # Orchestration functions (one per API operation)
├── main.ts             # Deno.serve routes + Deno.cron tick
├── canary.rune         # Rune spec (source of truth for requirements)
└── deno.json
```

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
```

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

Visit [http://localhost:8000](http://localhost:8000) and log in with the `ADMIN_USERNAME` / `ADMIN_PASSWORD` from your `.env`. The dashboard lets you create monitors, configure checks/alerts, invite teammates, manage webhook keys, and fire one-off test alerts — everything below is also doable via the API.

---

## API Reference

All routes return JSON. Every admin route requires `Authorization: Bearer <session-token>` (obtained from `POST /auth/login`). The webhook-fire route uses its own per-monitor bearer secret instead.

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

**Create a monitor**

```json
POST /monitors
{
  "name": "Production API",
  "description": "Watches the /health endpoint"
}
```

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
  "notifyOnRecover": true
}
```

| Field | Description |
|-------|-------------|
| `expression` | Dot-notation path into the JSON response body |
| `comparatorOp` | `gt`, `lt`, `gte`, `lte`, or `eq` |
| `threshold` | Numeric value to compare against |
| `cron` | Standard 5-field cron expression |
| `notifyOnRecover` | Send an alert when the monitor returns to healthy |

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

The `ntfy` address can be a bare topic name (`adam-code-alerts` → `https://ntfy.sh/adam-code-alerts`), `ntfy.sh/<topic>`, or a full URL to a self-hosted ntfy server. Failing checks send with `Priority: high` + `Tags: warning`; recoveries send with `Priority: default` + `Tags: white_check_mark`.

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

### Diagnostics

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | Public — `{ status, startedAt, lastCronTick, monitors: count }`. |
| `GET` | `/api/debug` | Admin — full KV snapshot: monitors, checks (with `matchesNow`), alerts (with channel list + custom-template flags), latest run per monitor, webhooks (existence + fingerprint), env-var presence booleans. The first place to look when "alerts aren't arriving." |

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

ntfy doesn't need any env vars — the topic is configured per-recipient on each monitor.

**Session signing key:** the HMAC key that signs login sessions is generated
automatically on first boot and stored in Deno KV (`["config", "session-signing-key"]`).
No env var is required, and there is no predictable fallback. Deleting that KV
entry rotates the key and invalidates every live session (a clean "log everyone out").

---

## License

MIT
