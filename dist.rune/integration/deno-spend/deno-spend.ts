import { parseCurrentUsageCost, parseSpendLimits, pctOfLimit } from "../../pure/deno-spend/deno-spend.ts";
import type { DenoSpendDto } from "../../dto/deno-spend-dto.ts";
import { CanaryError } from "../../dto/_shared.ts";
import { Secret } from "../../impure/secret/secret.ts";
import { log } from "../../impure/_log.ts";

// The Deno console's dashboard billing API (tRPC). Unlike the public
// api.deno.com/v2 token API, this exposes real dollars — but it is authed by a
// browser SESSION cookie (`token=ddw_…`), not the ddo_ API token, and it is
// undocumented/internal. Kept isolated here so its fragility is contained.
const TRPC = "https://console.deno.com/api/billing.currentUsageCost,billing.getSpendLimits";

function round(n: number, dp: number): number {
  return Number(n.toFixed(dp));
}

/**
 * Resolve DD_SESSION_TOKEN / DD_ORG_ID from the Canary SECRET STORE first, then
 * the deploy env. The session cookie EXPIRES and needs periodic refreshing —
 * a secret is paste-and-done from the dashboard, while an env var change means
 * touching the deployment. The env fallback keeps an existing env-only setup
 * working unchanged.
 */
export async function resolveConfig(name: string): Promise<string | undefined> {
  try {
    const v = await new Secret().resolve(name);
    if (v && v.trim()) return v.trim();
  } catch {
    // not stored as a secret — fall through to env
  }
  const env = Deno.env.get(name);
  return env && env.trim() ? env.trim() : undefined;
}

/**
 * Read the org's real usage-based spend + live spend limit from the Deno
 * console. Requires `DD_SESSION_TOKEN` (the `ddw_` cookie value) and
 * `DD_ORG_ID`. On a rejected/expired session (401/403) it throws a 401 so the
 * monitor FAILS LOUD ("refresh the cookie") rather than silently reporting a
 * stale or zero number.
 */
export async function getDenoSpend(): Promise<DenoSpendDto> {
  const token = await resolveConfig("DD_SESSION_TOKEN");
  const org = await resolveConfig("DD_ORG_ID");
  if (!token) {
    throw new CanaryError(
      "config-error",
      "DD_SESSION_TOKEN is not configured — save it as a Canary secret (dashboard → Secrets) or a deploy env var",
      500,
    );
  }
  if (!org) throw new CanaryError("config-error", "DD_ORG_ID is not configured (Canary secret or deploy env var)", 500);

  const input = encodeURIComponent(JSON.stringify({ "0": { json: { org } }, "1": { json: { org } } }));
  const res = await fetch(`${TRPC}?batch=1&input=${input}`, {
    headers: { "Cookie": `token=${token}`, "Accept": "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    throw new CanaryError(
      "session-expired",
      `Deno console session rejected (HTTP ${res.status}) — refresh DD_SESSION_TOKEN (dashboard → Secrets → Get Deno session token, then save the fresh value — no redeploy needed)`,
      401,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CanaryError("upstream-error", `Deno billing tRPC returned ${res.status}: ${body.slice(0, 160)}`, 502);
  }

  // tRPC batch (GET) → array aligned to the procedures; each `.result.data` is a
  // (non-JSON) serialized string parsed by the pure module.
  const arr = await res.json() as Array<{ result?: { data?: string } }>;
  const usageStr = arr?.[0]?.result?.data;
  const limitsStr = arr?.[1]?.result?.data;
  if (typeof usageStr !== "string" || typeof limitsStr !== "string") {
    throw new CanaryError("upstream-error", "Deno billing tRPC: unexpected response shape", 502);
  }

  const spend = parseCurrentUsageCost(usageStr);
  const { limitUSD, thresholds } = parseSpendLimits(limitsStr);
  const dto: DenoSpendDto = {
    ok: true,
    spendUSD: round(spend.totalUSD, 2),
    limitUSD,
    pctOfLimit: round(pctOfLimit(spend.totalUSD, limitUSD), 1),
    thresholds,
    items: spend.items.map((i) => ({ description: i.description, costUSD: round(i.costUSD, 2) })),
    asOf: new Date().toISOString(),
  };
  log.info(`✅ deno-spend: $${dto.spendUSD} of $${dto.limitUSD} (${dto.pctOfLimit}%)`);
  return dto;
}
