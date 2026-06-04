# canary-reporter

The producer side of the [Canary](../README.md) health contract. Record errors
anywhere in your app and expose one endpoint; Canary polls it on a schedule and
alerts when errors appear or the service goes unreachable.

Designed for Deno Deploy projects (Deno KV by default), but the store is
pluggable.

## Use it (≈5 lines)

```ts
import { CanaryReporter } from "https://raw.githubusercontent.com/WSAdam/Canary/master/reporter/mod.ts";

const canary = new CanaryReporter({ secret: Deno.env.get("CANARY_SECRET")! });

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Expose the contract — Canary calls this on a schedule.
  if (req.method === "POST" && url.pathname === "/canary/errors") {
    return canary.handleErrors(req);
  }

  // ...your routes. Record an error wherever one happens:
  // await canary.trackError("checkout", err.message, { ref: orderId });

  return new Response("ok");
});
```

Then in Canary, add the integration (dashboard **+ Add integration**, or
`POST /integrations`) with this project's base URL and the same `CANARY_SECRET`.

## The contract

`POST /canary/errors`, `Authorization: Bearer <secret>`, optional
`?date=YYYY-MM-DD`. Returns:

```json
{ "ok": true, "timezone": "America/New_York", "date": "2026-06-02",
  "window": { "since": 1780372800000, "until": 1780459200000 },
  "totalErrors": 0, "refs": [], "errors": [] }
```

Canary extracts `totalErrors`; **healthy = 0**. The window is one calendar day in
`timezone`, defaulting to **yesterday** (so a daily check reports the last full
day). `errors[]` entries are `{ ref, step, error, ts, timestamp, logsUrl? }`.

## API

`new CanaryReporter(options)`:

| option | default | meaning |
|--------|---------|---------|
| `secret` | — (required) | bearer secret the endpoint requires |
| `store` | Deno KV | persistence backend (`Store` interface) |
| `timezone` | `America/New_York` | IANA tz for the day window |
| `retentionMs` | 8 days | how long error rows are kept |
| `prefix` | `canary-errors` | KV key prefix (default store) |
| `logsUrlFor` | — | `(ref, req) => string` to attach a logs link per error |

- `trackError(step, error, { ref? })` — record an error. Fail-safe: never throws.
- `handleErrors(req)` — handle `POST /canary/errors`.
- `getErrorsInWindow(from, to)` — raw rows in a `[from, to)` ms window.

### Custom store

Swap Deno KV for anything by implementing `Store` (`put` + `list`); pass it as
`store`. `memoryStore()` is provided for tests.

## Test

```bash
deno test reporter/
```
