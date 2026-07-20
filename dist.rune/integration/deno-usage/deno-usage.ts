import {
  buildReport,
  compareLatest,
  formatBreakdown,
  formatTrend,
  isActiveApp,
  type Metric,
  mergeTotals,
  rankApps,
  sumAnalyticsByDay,
  sumAnalyticsWhere,
  toAppUsage,
  toDayUsage,
  TREND_COLUMNS,
  type TrendComparison,
  type TrendKey,
} from "../../pure/deno-usage/deno-usage.ts";
import type { AnalyticsResponse, AppUsage } from "../../pure/deno-usage/deno-usage.ts";
import type { DenoUsageDto } from "../../dto/deno-usage-dto.ts";
import { CanaryError } from "../../dto/_shared.ts";
import { dayKey, formatDisplay, formatRange, resolveWindow, trailingDays } from "../../pure/time-window/time-window.ts";
import { log } from "../../impure/_log.ts";

// Trend length. Capped because each extra day widens every per-app analytics
// call; 31 keeps the fetch inside a handful of chunks per app.
const MAX_TRAILING_DAYS = 31;

/** `?trailing=N` → a day count, or 0 when absent/invalid (trend omitted). */
function parseTrailing(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 2) return 0; // a 1-day "trend" compares nothing
  return Math.min(Math.floor(n), MAX_TRAILING_DAYS);
}

const BASE = "https://api.deno.com/v2";
// The analytics endpoint rejects a single query whose range exceeds 7 days
// ("Requested analytics range must not exceed 7 days"), so any longer window is
// split into ≤7-day chunks and summed. 24h (the digest) is a single chunk.
const MAX_CHUNK_MS = 6 * 24 * 3600 * 1000; // 6 days, safely under the 7-day cap

interface DenoApp {
  id: string;
  slug: string;
}

function windows(sinceMs: number, untilMs: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let s = sinceMs; s < untilMs; s += MAX_CHUNK_MS) {
    const e = Math.min(s + MAX_CHUNK_MS, untilMs);
    out.push([new Date(s).toISOString(), new Date(e).toISOString()]);
  }
  return out;
}

async function denoGet(path: string, token: string): Promise<Response> {
  return await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

/**
 * Sum org-wide Deno Deploy usage across every app in the org the `DD_ORG_TOKEN`
 * is scoped to, over the window named by `params` (`?day=` / `?from=&to=` /
 * `?hours=`, default a rolling 24h — see resolveWindow). Per-app analytics are
 * chunked to respect the API's 7-day range cap and summed with the pure
 * aggregator. One app's failed analytics call is logged and skipped (counted in
 * `appsErrored`) so a single bad app can't blank the whole digest. Apps with no
 * activity in the window are omitted from `byApp` and counted in `appsIdle`.
 */
export async function getDenoUsage(params: URLSearchParams = new URLSearchParams()): Promise<DenoUsageDto> {
  const token = Deno.env.get("DD_ORG_TOKEN");
  if (!token) throw new CanaryError("config-error", "DD_ORG_TOKEN is not configured", 500);

  const { since, until } = resolveWindow(params);
  const hours = Number(((until.getTime() - since.getTime()) / 3_600_000).toFixed(2));

  // ?trailing=N adds the N complete days ending with the reporting day. The
  // fetch window is widened to cover them, and BOTH the primary totals and the
  // per-day series are derived from that one pass — the trend costs no extra
  // API calls, only a wider range on the calls already being made.
  const trailingDaysCount = parseTrailing(params.get("trailing"));
  const days = trailingDaysCount > 0 ? trailingDays(until, trailingDaysCount) : [];
  const fetchSince = days.length > 0 && days[0].since < since ? days[0].since : since;
  log.info(
    `🔍 deno-usage: summing ${formatRange(since, until)} across org apps` +
      (trailingDaysCount > 0 ? ` (+${trailingDaysCount}d trend from ${formatDisplay(fetchSince)})` : ""),
  );

  // `limit` is capped at 100 by the API. Orgs above 100 apps would need paging;
  // warn rather than silently undercount if we ever hit the ceiling.
  const appsRes = await denoGet(`/apps?limit=100`, token);
  if (!appsRes.ok) {
    const body = await appsRes.text().catch(() => "");
    throw new CanaryError("upstream-error", `Deno GET /apps returned ${appsRes.status}: ${body.slice(0, 200)}`, 502);
  }
  const apps: DenoApp[] = await appsRes.json();
  if (apps.length >= 100) log.warn(`⚠️ deno-usage: hit the 100-app page limit — usage may undercount (add paging)`);

  const chunks = windows(fetchSince.getTime(), until.getTime());
  const sinceMs = since.getTime();
  const untilMs = until.getTime();
  const inPrimary = (t: number) => t >= sinceMs && t <= untilMs;
  const perApp: Array<Record<Metric, number>> = [];
  const byApp: AppUsage[] = [];
  // Org-wide per-day totals, accumulated across every app.
  const dayTotals: Record<string, Record<Metric, number>> = {};
  let appsErrored = 0;
  for (const app of apps) {
    const parts: Array<Record<Metric, number>> = [];
    let failed = false;
    for (const [s, u] of chunks) {
      const r = await denoGet(`/apps/${app.id}/analytics?since=${s}&until=${u}`, token);
      if (r.ok) {
        const res = await r.json() as AnalyticsResponse;
        // The fetched range can be wider than the reporting window (trend), so
        // the app's own totals count only the buckets inside it.
        parts.push(sumAnalyticsWhere(res, inPrimary));
        if (days.length > 0) {
          for (const [key, totals] of Object.entries(sumAnalyticsByDay(res, (t) => dayKey(new Date(t))))) {
            dayTotals[key] = mergeTotals([dayTotals[key] ?? mergeTotals([]), totals]);
          }
        }
      } else {
        await r.body?.cancel();
        failed = true;
        log.warn(`⚠️ deno-usage: analytics for ${app.slug} → HTTP ${r.status}`);
      }
    }
    if (failed) appsErrored++;
    const totals = mergeTotals(parts);
    perApp.push(totals);
    // Keep the per-app slice as well as folding it into the org total, so the
    // digest can answer "which app drove that?" without a second API pass.
    byApp.push(toAppUsage(app.slug, totals, failed));
  }

  const t = mergeTotals(perApp);
  const round = (n: number, dp: number) => Number(n.toFixed(dp));
  const ranked = rankApps(byApp);
  // Dormant apps are dropped from the payload entirely — a row of zeroes is
  // noise. Their COUNT is kept (appsIdle) so "23 apps, 6 listed" is still
  // explicable, and formatBreakdown gets the unfiltered list so its trailing
  // "+N idle" tally stays accurate.
  const active = ranked.filter(isActiveApp);
  const breakdown = formatBreakdown(ranked);

  // A day with no traffic still gets a row (zeroes), so a gap in the series
  // reads as "quiet day" rather than silently vanishing from the trend.
  const series = days.map((d) => toDayUsage(d.key, d.label, dayTotals[d.key] ?? mergeTotals([])));
  const trailing = series.length > 0
    ? {
      days: series.length,
      series,
      comparison: Object.fromEntries(
        TREND_COLUMNS.map((c) => [c.key, compareLatest(series, c.key)]),
      ) as Record<TrendKey, TrendComparison>,
      table: formatTrend(series),
    }
    : undefined;

  const dto: DenoUsageDto = {
    ok: true,
    window: {
      since: since.toISOString(),
      until: until.toISOString(),
      hours,
      sinceLocal: formatDisplay(since),
      untilLocal: formatDisplay(until),
      label: formatRange(since, until),
    },
    apps: apps.length,
    appsErrored,
    requests: t.request_count,
    kvReadUnits: t.kv_read_units,
    kvWriteUnits: t.kv_write_units,
    egressGB: round(t.network_egress_bytes / 1e9, 3),
    cpuHours: round(t.cpu_seconds / 3600, 2),
    memoryGBHours: round(t.memory_time_byte_seconds / (1e9 * 3600), 1),
    appsActive: active.length,
    appsIdle: ranked.length - active.length,
    byApp: active,
    breakdown,
    trailing,
    report: buildReport({
      windowLabel: formatRange(since, until),
      requests: t.request_count,
      kvReadUnits: t.kv_read_units,
      kvWriteUnits: t.kv_write_units,
      egressGB: round(t.network_egress_bytes / 1e9, 3),
      cpuHours: round(t.cpu_seconds / 3600, 2),
      appsActive: active.length,
      apps: apps.length,
      breakdown,
      trend: trailing?.table,
      trendDays: trailing?.days,
    }),
  };
  log.info(`✅ deno-usage: ${dto.apps} apps (${appsErrored} errored) — ${dto.requests} req, ${dto.kvReadUnits} KV-read, ${dto.kvWriteUnits} KV-write`);
  return dto;
}
