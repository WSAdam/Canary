# Handoff: wire the SMS bot into Canary's nightly report

**Audience:** whoever (or whichever coding agent) works in the **SMS bot** repo.
**Goal:** have Canary run a nightly health report on the SMS bot, exactly like it
already does for `autobottom` — alerting if the bot logged errors in the last day,
**or** if the bot is unreachable.

You do **not** need to read Canary's source. The SMS bot only has to expose one
HTTP endpoint that speaks the **Canary health contract**. Canary polls it on a
schedule and decides healthy/unhealthy.

---

## How it works (pull, not push)

```
            nightly cron (~09:00 ET)
Canary  ───────────────────────────────▶  POST /canary/errors   (SMS bot)
        ◀───────────────────────────────  { totalErrors, errors[], … }

  totalErrors === 0  → healthy, no alert
  totalErrors  >  0  → alert (SMS/email/ntfy to the recipients you set in Canary)
  fetch fails / non-2xx / bad shape → alert ("the bot is down/miswired")
```

Canary reads one number — **`totalErrors`** for a calendar day (default: the
**previous full day** in `America/New_York`). `0` is healthy. Because Canary
*polls*, a deploy that's completely down also alerts (a push model couldn't catch
that). This is the same contract `autobottom` exposes.

The SMS bot is a Deno / Deno Deploy app, so you get the producer side from the
drop-in `reporter/` module that ships with Canary — about five lines.

---

## Part A — work to do in the SMS bot repo

### 1. Add the reporter

```ts
import { CanaryReporter } from "https://raw.githubusercontent.com/WSAdam/Canary/master/reporter/mod.ts";

const canary = new CanaryReporter({
  secret: Deno.env.get("CANARY_SECRET")!,        // shared bearer secret (see step 4)
  // timezone: "America/New_York",               // default; the day window is in this tz
  // retentionMs: 8 * 24 * 60 * 60 * 1000,        // default 8 days
});
```

> Prefer not to fetch code at runtime? Vendor it: copy Canary's `reporter/` folder
> into the SMS bot repo and import from the local path instead. The API is identical.

### 2. Expose the contract endpoint

Add this one route to the SMS bot's `Deno.serve` handler. It's the *entire*
integration on the serving side:

```ts
Deno.serve(async (req) => {
  const { pathname } = new URL(req.url);

  // Canary calls this on a schedule.
  if (req.method === "POST" && pathname === "/canary/errors") {
    return canary.handleErrors(req);   // verifies the bearer secret, returns the day's report
  }

  // …the bot's existing routes…
});
```

### 3. Record errors where they actually happen

`trackError(step, message, { ref? })` is **fail-safe — it never throws**, so you
can call it from inside a `catch` without wrapping it. Put it everywhere a real
failure occurs. For an SMS bot the high-value spots are:

```ts
// a) An outbound send that the provider rejected (Twilio/Zapier/etc.)
try {
  await sendSms(to, body);
} catch (err) {
  await canary.trackError("send", `SMS send failed to ${to}: ${err.message}`, { ref: messageId });
  throw err; // keep your own handling
}

// b) A provider returned a non-2xx (delivery/status webhook, send API, …)
if (!resp.ok) {
  await canary.trackError("provider", `${provider} returned ${resp.status}`, { ref: messageId });
}

// c) An inbound webhook / command handler blew up
catch (err) {
  await canary.trackError("inbound-webhook", err.message, { ref: req.headers.get("x-request-id") ?? undefined });
}

// d) Backstop: any unhandled error in the request pipeline
catch (err) {
  await canary.trackError("unhandled", err instanceof Error ? err.message : String(err));
}
```

`step` is a free-form label that groups errors (`"send"`, `"provider"`,
`"inbound-webhook"`, …). `ref` is optional but handy — a message id / request id
you can grep your logs for. **Don't** track expected user errors (e.g. an opt-out
keyword, a 4xx the user caused) — only things that mean *the bot is unhealthy*,
or the nightly report will cry wolf.

### 4. Configuration & deploy

- **Env var:** set `CANARY_SECRET` in the SMS bot's Deno Deploy project to a long
  random string. (Generate one: `openssl rand -hex 24`.) Document it in the SMS
  bot README — do **not** commit it. You'll paste the same value into Canary in
  Part B.
- **Permissions:** the reporter uses Deno KV by default. Running locally needs
  `--unstable-kv` (and `--allow-net --allow-env`); Deno Deploy provides KV with no
  flags.
- If the SMS bot is *not* on Deno KV, pass a custom `store` implementing the
  `Store` interface (`put` + `list`) to `new CanaryReporter({ store, … })`.
  `memoryStore()` is exported for tests.

That's the whole producer side. Commit, deploy, confirm `CANARY_SECRET` is set.

---

## Part B — work to do in Canary (the one-time hookup)

This is done **in Canary**, not the SMS bot — included here so the handoff is
end-to-end. Either click **+ Add integration** in the Canary dashboard, or:

```bash
curl -X POST $CANARY_URL/integrations \
  -H "Authorization: Bearer $CANARY_SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "sms-bot",
    "baseUrl": "https://<the-sms-bot>.deno.net",
    "secret": "<the same CANARY_SECRET from Part A>",
    "recipients": [{ "channel": "ntfy", "address": "adam-code-alerts" }],
    "cron": "0 13 * * *"
  }'
```

- `cron: "0 13 * * *"` is **13:00 UTC ≈ 09:00 ET**, reporting the previous full ET
  day — same cadence as `autobottom`. Omit `cron` to take Canary's daily default.
- `recipients` can mix `sms` / `email` / `ntfy` — whatever you want the nightly
  report to page.
- The response includes a `firstRun` (an immediate verification poll). If
  `firstRun.error` is set, the wiring is wrong (unreachable / bad secret / wrong
  shape) — fix that before trusting the nightly run. Otherwise `firstRun.passed`
  reflects the bot's prior-day health right now.

Behind the scenes Canary stores the secret as `SMS_BOT_CANARY_SECRET`, configures
a `POST <baseUrl>/canary/errors` check with `expression: "totalErrors"`,
pass-when-`≤ 0`, and `notifyOnRecover: true`.

---

## The contract (reference)

`POST /canary/errors`, header `Authorization: Bearer <CANARY_SECRET>`, optional
`?date=YYYY-MM-DD`. Response:

```json
{
  "ok": true,
  "timezone": "America/New_York",
  "date": "2026-06-29",
  "window": { "since": 1782000000000, "until": 1782086400000 },
  "totalErrors": 0,
  "refs": [],
  "errors": []
}
```

`errors[]` entries are `{ ref, step, error, ts, timestamp, logsUrl? }`. Canary only
*requires* `totalErrors`; the rest is surfaced in the alert/run detail when present.

---

## Verify it end-to-end

Run these against the **deployed SMS bot** once Part A is live:

```bash
SECRET=...   # the CANARY_SECRET you set
BASE=https://<the-sms-bot>.deno.net

# 1. Contract responds and authenticates (should be 200 with totalErrors)
curl -s -X POST $BASE/canary/errors -H "Authorization: Bearer $SECRET" | jq

# 2. Wrong secret is rejected (should be 401)
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/canary/errors -H "Authorization: Bearer nope"

# 3. Record a test error, then check today's window shows it
#    (use ?date=YYYY-MM-DD for today since the default window is *yesterday*)
#    …trigger a real error path, or temporarily add a /boom route like reporter/example.ts…
curl -s -X POST "$BASE/canary/errors?date=$(date -u +%F)" -H "Authorization: Bearer $SECRET" | jq '.totalErrors, .errors'
```

Then in Canary, confirm the integration's `firstRun.error` is absent and the
`sms-bot` monitor appears under **Reports**.

---

## Definition of done (SMS bot side)

- [ ] `POST /canary/errors` is live and returns the contract JSON.
- [ ] It returns `401` without the correct bearer secret.
- [ ] `CANARY_SECRET` is set in the deployed environment (and in the README, not git).
- [ ] `trackError(...)` is called at the real failure sites (send failures, provider
      non-2xx, inbound-webhook errors, an unhandled backstop) — and **not** on
      expected user errors.
- [ ] A manually triggered error shows up in the `?date=<today>` window.
- [ ] (Canary side) `POST /integrations` for `sms-bot` returns a clean `firstRun`.

Reference implementation to copy from: Canary's [`reporter/example.ts`](reporter/example.ts)
and [`reporter/README.md`](reporter/README.md). `autobottom` is the existing live
example of this exact integration.
