import { type Metric, mergeTotals, sumAnalytics } from "../../pure/deno-usage/deno-usage.ts";
import type { AnalyticsResponse } from "../../pure/deno-usage/deno-usage.ts";
import type { DenoUsageDto } from "../../dto/deno-usage-dto.ts";
import { CanaryError } from "../../dto/_shared.ts";
import { log } from "../../impure/_log.ts";

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
 * Sum org-wide Deno Deploy usage over the last `hours` (default 24) across every
 * app in the org the `DD_ORG_TOKEN` is scoped to. Per-app analytics are chunked to
 * respect the API's 7-day range cap and summed with the pure aggregator. One
 * app's failed analytics call is logged and skipped (counted in `appsErrored`)
 * so a single bad app can't blank the whole digest.
 */
export async function getDenoUsage(hours = 24): Promise<DenoUsageDto> {
  const token = Deno.env.get("DD_ORG_TOKEN");
  if (!token) throw new CanaryError("config-error", "DD_ORG_TOKEN is not configured", 500);

  const until = new Date();
  const since = new Date(until.getTime() - hours * 3600 * 1000);
  log.info(`🔍 deno-usage: summing ${hours}h across org apps (${since.toISOString()} → ${until.toISOString()})`);

  // `limit` is capped at 100 by the API. Orgs above 100 apps would need paging;
  // warn rather than silently undercount if we ever hit the ceiling.
  const appsRes = await denoGet(`/apps?limit=100`, token);
  if (!appsRes.ok) {
    const body = await appsRes.text().catch(() => "");
    throw new CanaryError("upstream-error", `Deno GET /apps returned ${appsRes.status}: ${body.slice(0, 200)}`, 502);
  }
  const apps: DenoApp[] = await appsRes.json();
  if (apps.length >= 100) log.warn(`⚠️ deno-usage: hit the 100-app page limit — usage may undercount (add paging)`);

  const chunks = windows(since.getTime(), until.getTime());
  const perApp: Array<Record<Metric, number>> = [];
  let appsErrored = 0;
  for (const app of apps) {
    const parts: Array<Record<Metric, number>> = [];
    let failed = false;
    for (const [s, u] of chunks) {
      const r = await denoGet(`/apps/${app.id}/analytics?since=${s}&until=${u}`, token);
      if (r.ok) {
        parts.push(sumAnalytics(await r.json() as AnalyticsResponse));
      } else {
        await r.body?.cancel();
        failed = true;
        log.warn(`⚠️ deno-usage: analytics for ${app.slug} → HTTP ${r.status}`);
      }
    }
    if (failed) appsErrored++;
    perApp.push(mergeTotals(parts));
  }

  const t = mergeTotals(perApp);
  const round = (n: number, dp: number) => Number(n.toFixed(dp));
  const dto: DenoUsageDto = {
    ok: true,
    window: { since: since.toISOString(), until: until.toISOString(), hours },
    apps: apps.length,
    appsErrored,
    requests: t.request_count,
    kvReadUnits: t.kv_read_units,
    kvWriteUnits: t.kv_write_units,
    egressGB: round(t.network_egress_bytes / 1e9, 3),
    cpuHours: round(t.cpu_seconds / 3600, 2),
    memoryGBHours: round(t.memory_time_byte_seconds / (1e9 * 3600), 1),
  };
  log.info(`✅ deno-usage: ${dto.apps} apps (${appsErrored} errored) — ${dto.requests} req, ${dto.kvReadUnits} KV-read, ${dto.kvWriteUnits} KV-write`);
  return dto;
}
