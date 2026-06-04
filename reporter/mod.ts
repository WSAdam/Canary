// canary-reporter — drop-in producer side of the Canary health contract.
//
// Record errors anywhere in your app with `trackError`, and expose
// `POST /canary/errors` with `handleErrors`. Canary then polls that endpoint
// on a schedule and alerts when `totalErrors > 0` (or it's unreachable).
//
//   const canary = new CanaryReporter({ secret: Deno.env.get("CANARY_SECRET")! });
//   await canary.trackError("checkout", err.message, { ref: orderId });
//   // in your router:
//   if (req.method === "POST" && url.pathname === "/canary/errors") {
//     return canary.handleErrors(req);
//   }

import { dayWindow } from "./window.ts";
import { kvStore, type Store, type StoredError } from "./store.ts";

const DAY_MS = 86_400_000;

export interface CanaryReporterOptions {
  /** Bearer secret the /canary/errors endpoint requires (give Canary the same). */
  secret: string;
  /** Storage backend. Defaults to Deno KV (opened lazily on first use). */
  store?: Store;
  /** IANA timezone for the calendar-day window. Default "America/New_York". */
  timezone?: string;
  /** Retention for recorded errors. Default 8 days (covers "yesterday" + a week). */
  retentionMs?: number;
  /** KV key prefix when using the default KV store. Default "canary-errors". */
  prefix?: string;
  /** Optional per-error logs link, e.g. a Deno Deploy console URL for `ref`. */
  logsUrlFor?: (ref: string, req: Request) => string;
}

/** One error as reported over the wire. */
export interface ReportedError {
  ref: string;
  step: string;
  error: string;
  ts: number;
  timestamp: string;
  logsUrl?: string;
}

/** The Canary health contract response shape. `totalErrors` is the field
 *  Canary extracts and compares (healthy = 0). */
export interface HealthReport {
  ok: true;
  timezone: string;
  date: string;
  window: { since: number; until: number };
  totalErrors: number;
  refs: string[];
  errors: ReportedError[];
}

export class CanaryReporter {
  #opts: CanaryReporterOptions;
  #storeP?: Promise<Store>;
  #seq = 0;

  constructor(opts: CanaryReporterOptions) {
    if (!opts?.secret) throw new Error("CanaryReporter: `secret` is required");
    this.#opts = opts;
  }

  get #tz(): string {
    return this.#opts.timezone ?? "America/New_York";
  }
  get #retention(): number {
    return this.#opts.retentionMs ?? 8 * DAY_MS;
  }

  async #store(): Promise<Store> {
    if (this.#opts.store) return this.#opts.store;
    this.#storeP ??= Deno.openKv().then((kv) => kvStore(kv, this.#opts.prefix));
    return this.#storeP;
  }

  /** Record an error. `ref` is an optional identifier (order id, job id, …)
   *  that Canary's report and any logs link can key off. Fail-safe: never
   *  throws — a reporting failure must not break your real work. */
  async trackError(step: string, error: string, opts?: { ref?: string }): Promise<void> {
    try {
      const ts = Date.now();
      const ref = opts?.ref ?? "";
      const id = `${ts}-${this.#seq++}-${ref}`;
      const store = await this.#store();
      await store.put({ id, ref, step, error, ts }, { expireInMs: this.#retention });
    } catch (e) {
      console.error("⚠️ canary-reporter: trackError failed (ignored):", e);
    }
  }

  /** All recorded errors with ts in [from, to), oldest first. */
  async getErrorsInWindow(from: number, to: number): Promise<StoredError[]> {
    const rows = await (await this.#store()).list();
    return rows.filter((r) => r.ts >= from && r.ts < to).sort((a, b) => a.ts - b.ts);
  }

  /** Handle `POST /canary/errors`. Bearer-auth'd; optional `?date=YYYY-MM-DD`
   *  overrides the default (yesterday) window. */
  async handleErrors(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "POST required" }, 405);
    if (!bearerEquals(req.headers.get("Authorization") ?? "", this.#opts.secret)) {
      return json({ error: "unauthorized" }, 401);
    }
    const dateOverride = new URL(req.url).searchParams.get("date") ?? undefined;
    const { since, until, date } = dayWindow(Date.now(), this.#tz, dateOverride);
    const rows = await this.getErrorsInWindow(since, until);

    const errors: ReportedError[] = rows.map((r) => ({
      ref: r.ref,
      step: r.step,
      error: r.error,
      ts: r.ts,
      timestamp: new Date(r.ts).toISOString(),
      ...(this.#opts.logsUrlFor && r.ref ? { logsUrl: this.#opts.logsUrlFor(r.ref, req) } : {}),
    }));

    const report: HealthReport = {
      ok: true,
      timezone: this.#tz,
      date,
      window: { since, until },
      totalErrors: rows.length,
      refs: [...new Set(rows.map((r) => r.ref).filter(Boolean))],
      errors,
    };
    return json(report);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/** Constant-time-ish bearer compare (length is allowed to leak, like the
 *  reference implementation). */
function bearerEquals(header: string, secret: string): boolean {
  const expected = `Bearer ${secret}`;
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export { kvStore, memoryStore, type Store, type StoredError } from "./store.ts";
export { dayWindow, type DayWindow } from "./window.ts";
