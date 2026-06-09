# Integrating your project with Canary

This is the contract another project follows so **Canary** can monitor it and
alert us when something's wrong. Hand this whole file to the project (or its
agent).

---

## The model in one paragraph

Canary polls **one endpoint on your service** on a schedule. From your JSON
response it reads **one numeric value** (by a dot-path you don't have to know
about), compares it against a threshold with an operator, and **alerts when the
comparison fails or your endpoint can't be reached.** You don't decide what
"healthy" means or which field matters — we configure that on our side. Your job
is just to expose the number.

> Think of it exactly like a health/metrics report: you return a report, we pick
> a value from it and weigh it. (e.g. *"read `totalRecords`; page us when it goes
> above 30"*, or *"read `totalErrors`; page us when it's not 0"*.)

---

## What you must expose

**An authenticated HTTP endpoint that returns JSON containing the number(s) you
want watched.** That's the whole requirement.

### 1. The endpoint
- **Method:** `GET` or `POST` — your choice. (If you use our Deno drop-in below,
  it's `POST /canary/errors`.)
- **Path:** anything (e.g. `/canary/errors`, `/health`, `/metrics/report`). You
  give us the full base URL.
- It must respond in **under ~10 seconds** (our fetch times out around 10s and a
  timeout counts as a failure).

### 2. Auth
- Require an `Authorization: Bearer <SECRET>` header.
- **Reject anything else with HTTP `401`.** Use a constant-time comparison.
- Pick any hard-to-guess secret, store it in your env (e.g. `CANARY_SECRET`), and
  give us the **same** value when we add the integration. We send it on every
  request; nothing else should be able to read your report.

### 3. The response
- On success, return **HTTP `200`** with a JSON body.
- The body must contain at least **one numeric field** we can reach by a
  dot-path. Nested objects and array indices are fine:
  - `{ "totalErrors": 0 }` → path `totalErrors`
  - `{ "queue": { "depth": 4 } }` → path `queue.depth`
  - `{ "items": [ { "count": 12 } ] }` → path `items.0.count`
- The watched value **must be a number** (not a string like `"12"`). If the path
  is missing or non-numeric, the check fails.
- Return whatever else you like alongside it — extra fields are ignored by the
  comparison but show up in our run history for debugging.

### 4. Status codes carry meaning
| You return | Canary reads it as |
|---|---|
| `200` + JSON | a real reading — compared against the threshold |
| any non-`2xx` (incl. `401`, `5xx`) | **failure** → alert |
| timeout / connection refused / DNS fail | **failure** → alert (free down-detection) |

So: return `200` when things are fine, even if the watched number is "bad" — let
the **value**, not the status code, signal the problem. Reserve non-2xx for
genuine errors (bad auth, your service is broken).

---

## How we evaluate it (so the numbers make sense)

On our side, a check is `value <operator> threshold`. The operator expresses the
**healthy** condition; an alert fires when the check **fails** (and optionally
again when it recovers).

| operator | healthy when | example |
|---|---|---|
| `lte` | value ≤ threshold | errors `lte 0` → healthy at 0, alert at ≥1 |
| `lt`  | value < threshold | |
| `gte` | value ≥ threshold | throughput `gte 100` → alert if it drops below 100 |
| `gt`  | value > threshold | |
| `eq`  | value = threshold | |

**Worked examples:**

- **Error count.** You return `{ "totalErrors": 0 }`. We configure
  `totalErrors / lte / 0`. Healthy while 0; the first error pages us.
- **Confirmations / record count.** You return `{ "totalRecords": 12 }`. We
  configure `totalRecords / lte / 30`. Healthy while ≤ 30; climbing past 30 pages
  us.
- **Throughput floor.** You return `{ "rps": 240 }`. We configure `rps / gte /
  50`. Healthy while ≥ 50; a stall below 50 pages us.

You don't pick the operator/threshold — just make sure the number you return
means what you think it means.

---

## Recommended response shape

Minimal and valid:

```json
{ "ok": true, "totalErrors": 0 }
```

Richer (the extra fields aren't required, but they make our failure drill-in
useful — return whatever's relevant to your metric):

```json
{
  "ok": true,
  "timezone": "America/New_York",
  "date": "2026-06-03",
  "window": { "since": 1780459200000, "until": 1780545600000 },
  "totalErrors": 2,
  "errors": [
    {
      "ref": "order_123",
      "step": "checkout",
      "error": "Stripe webhook 500",
      "ts": 1780471234567,
      "timestamp": "2026-06-03T15:20:34.567Z"
    }
  ]
}
```

**Windowing tip:** if your metric is a count over time (errors today, records
today), decide the window and be consistent. We poll daily by default, so a
common choice is **"yesterday" in your timezone** — by mid-morning the report
reflects the full previous day. A rolling 24h is fine too. (Our drop-in defaults
to yesterday.)

---

## Easiest path for Deno / Deno Deploy projects

If you're on Deno, don't hand-build the error-count version — use our drop-in. It
records errors, expires them, computes the calendar-day window, and serves the
contract:

```ts
import { CanaryReporter } from "https://raw.githubusercontent.com/WSAdam/Canary/master/reporter/mod.ts";

const canary = new CanaryReporter({ secret: Deno.env.get("CANARY_SECRET")! });

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Expose the contract:
  if (req.method === "POST" && url.pathname === "/canary/errors") {
    return canary.handleErrors(req);
  }

  // Record an error wherever one happens:
  // await canary.trackError("checkout", err.message, { ref: orderId });

  return new Response("ok");
});
```

Run with `--unstable-kv`. Full options (timezone, retention, custom store, logs
links): see `reporter/README.md` in this repo. The drop-in produces the
error-count shape (`totalErrors`); for any other metric, just return your own
JSON per the contract above.

---

## Conformance checklist

- [ ] One endpoint (`GET` or `POST`), returns JSON, responds in < 10s.
- [ ] Requires `Authorization: Bearer <SECRET>`; returns `401` otherwise (constant-time compare).
- [ ] On success: `200` + a JSON body containing a **numeric** field reachable by dot-path.
- [ ] Non-2xx only for genuine errors (don't 4xx/5xx just because a count is high).
- [ ] You can tell us: the **base URL**, the **secret**, the **field/path** to watch, and what counts as a problem (so we set the operator + threshold).

---

## What we do on our side (once)

We add the integration from the Canary dashboard (**+ Add integration**, or
`POST /integrations`) — or, for a non-error-count metric, the full **+ Add
monitor** wizard — providing your base URL, the shared secret, the field +
comparator + threshold, and who to alert. Canary stores the secret, builds the
scheduled check, and fires an immediate verification run so we see green (or a
wiring problem) on the spot. From then on it polls you on schedule and pages us
on breach or if you go dark.

Questions or a non-standard shape? Send us a sample of your endpoint's JSON
response and we'll wire the check to it.
