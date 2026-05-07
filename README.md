# Canary

Lightweight HTTP monitoring and alerting built on [Deno Deploy](https://deno.com/deploy).

Canary polls your HTTP endpoints on a cron schedule, extracts numeric values from JSON responses, and fires SMS or email alerts the moment a threshold is breached. It alerts again when it recovers.

---

## Features

- **Flexible scheduling**: configure monitors with a human-readable schedule or a raw cron expression
- **JSON metric extraction**: dot-notation path extraction from any JSON response
- **Threshold comparisons**: `gt`, `lt`, `gte`, `lte`, `eq`
- **Multi-channel alerts**: SMS via Zapier webhook or email via Postmark; mix recipients per monitor
- **Recovery notifications**: optional alert when a failing monitor returns to a healthy state
- **Secret management**: store sensitive values (API keys, bearer tokens) in Deno KV and reference them in monitor headers
- **Manual trigger**: fire any monitor on demand via `POST /run/:monitorId`
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

---

## API Reference

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
    { "channel": "email", "address": "oncall@example.com" }
  ]
}
```

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

Store sensitive strings in Deno KV and reference them in monitor headers.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/secrets` | Set a secret |
| `GET` | `/secrets` | List secret keys |
| `DELETE` | `/secrets/:key` | Delete a secret |

```json
POST /secrets
{ "key": "MY_API_KEY", "value": "sk-..." }
```

Use a secret in a monitor's headers:

```json
"headers": { "Authorization": "Bearer {{MY_API_KEY}}" }
```

---

### Manual Trigger

Fire a monitor immediately without waiting for its cron schedule:

```bash
POST /run/:monitorId
```

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
   - `ZAPIER_SMS_URL`
   - `POSTMARK_SERVER_TOKEN`
   - `POSTMARK_FROM_EMAIL`

Deno Deploy provides Deno KV out of the box. No additional database setup required.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZAPIER_SMS_URL` | For SMS alerts | Zapier webhook URL |
| `POSTMARK_SERVER_TOKEN` | For email alerts | Postmark server API token |
| `POSTMARK_FROM_EMAIL` | For email alerts | Verified sender address |

---

## License

MIT
