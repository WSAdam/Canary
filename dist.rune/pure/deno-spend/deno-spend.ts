// Parse the Deno Deploy console's tRPC billing payloads into clean numbers.
//
// The console dashboard's billing procedures (console.deno.com/api/
// billing.currentUsageCost / billing.getSpendLimits) return `result.data` as a
// STRING. Historically that used an unquoted-key serialization — NOT strict
// JSON — e.g.
//   {total:12.34,items:[{description:"KV Reads (units)",total:5.67}]}
// This is an UNDOCUMENTED interface and its shape has changed under us once
// already (2026-08), so parsing is layered: strict JSON first, then the legacy
// lenient regex, then a LOUD error carrying a payload snippet — never a silent
// zero. PURE, no I/O.

export interface SpendItem {
  description: string;
  costUSD: number;
}
export interface DenoSpend {
  totalUSD: number;
  items: SpendItem[];
}

/** First chars of the payload for a parse-failure message, so the run detail
 *  shows WHAT shape arrived instead of leaving us blind. Admin-only surface. */
function snippet(dataStr: string): string {
  return JSON.stringify(dataStr.slice(0, 180).replace(/\s+/g, " "));
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Pull {description, cost} pairs out of a JSON items array, tolerating the
 *  obvious key spellings so a rename doesn't blank the breakdown. */
function jsonItems(items: unknown): SpendItem[] {
  if (!Array.isArray(items)) return [];
  const out: SpendItem[] = [];
  for (const it of items) {
    if (typeof it !== "object" || it === null) continue;
    const o = it as Record<string, unknown>;
    const description = typeof o.description === "string" ? o.description : typeof o.name === "string" ? o.name : undefined;
    const costUSD = num(o.total) ?? num(o.cost) ?? num(o.amount);
    if (description !== undefined && costUSD !== undefined) out.push({ description, costUSD });
  }
  return out;
}

/**
 * Parse a `billing.currentUsageCost` data string → grand total + line items.
 *
 * Accepts BOTH serializations seen from the console: strict JSON (quoted keys)
 * and the legacy unquoted-key form. The legacy regex is anchored so a field
 * that merely CONTAINS "total" (e.g. `subtotal: 0`) can never be mistaken for
 * the grand total — that exact false match once turned a shape change into a
 * silent $0 that sailed past the guardrail's threshold.
 *
 * Fails LOUD (with a payload snippet) rather than guessing: no recognizable
 * total, or a $0 total with no line items (no real bill looks like that —
 * a genuine zero still itemizes), both throw.
 */
export function parseCurrentUsageCost(dataStr: string): DenoSpend {
  let totalUSD: number | undefined;
  let items: SpendItem[] = [];
  // Did the payload carry a RECOGNIZED items structure (even an empty one)?
  // This is what separates a trustworthy $0 from a misread shape below.
  let itemsStructureFound = false;

  // 1) Strict JSON (a possible future shape).
  try {
    const parsed = JSON.parse(dataStr);
    if (typeof parsed === "object" && parsed !== null) {
      const o = parsed as Record<string, unknown>;
      totalUSD = num(o.total) ?? num(o.totalUSD) ?? num(o.grandTotal);
      const rawItems = o.items ?? o.lines ?? o.breakdown;
      itemsStructureFound = Array.isArray(rawItems);
      items = jsonItems(rawItems);
    }
  } catch {
    // 2) Legacy unquoted-key serialization. The lookbehind anchors `total:` to
    //    a non-identifier boundary so `subtotal:`/`usageTotal:` can't match.
    //    Numbers may arrive WITHOUT a leading zero (`total:.159962`) — the
    //    serializer drops it on sub-1 values (seen live 2026-08-06).
    const grand = dataStr.match(/(?<![A-Za-z0-9_$"'])total:\s*(-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+))/);
    if (grand) totalUSD = Number(grand[1]);
    itemsStructureFound = /(?<![A-Za-z0-9_$"'])items:\s*\[/.test(dataStr);
    const re = /\{description:"((?:[^"\\]|\\.)*)",total:\s*(-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+))\}/g;
    for (let m = re.exec(dataStr); m; m = re.exec(dataStr)) {
      items.push({ description: m[1], costUSD: Number(m[2]) });
    }
  }

  if (totalUSD === undefined) {
    throw new Error(`currentUsageCost: no 'total' found — billing payload shape changed; payload starts: ${snippet(dataStr)}`);
  }
  if (totalUSD === 0 && items.length === 0 && !itemsStructureFound) {
    // $0 with no recognizable items structure at all is the signature of a
    // misread shape — fail loud so the guardrail can't be silently pinned at
    // 0% by a payload change. A $0 WITH an explicit (empty) items array is a
    // real number: exactly what the first hours after a billing-cycle renewal
    // look like ({total:0,items:[],usage:[]}, seen live 2026-08-31 8PM, cycle
    // renewal day — the guard's original form paged hourly on a true zero).
    throw new Error(`currentUsageCost: parsed $0 with no line items — likely a shape change; payload starts: ${snippet(dataStr)}`);
  }
  return { totalUSD, items };
}

/** Parse a `billing.getSpendLimits` data string (a JSON array like "[140,180,400]").
 *  The hard cap is the max; the smaller values are the configured alert thresholds. */
export function parseSpendLimits(dataStr: string): { limitUSD: number; thresholds: number[] } {
  let arr: unknown;
  try {
    arr = JSON.parse(dataStr);
  } catch {
    throw new Error(`getSpendLimits: not JSON; payload starts: ${snippet(dataStr)}`);
  }
  if (!Array.isArray(arr) || arr.length === 0 || arr.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    throw new Error(`getSpendLimits: expected a non-empty number array; payload starts: ${snippet(dataStr)}`);
  }
  const limitUSD = Math.max(...arr as number[]);
  const thresholds = (arr as number[]).filter((n) => n < limitUSD).sort((a, b) => a - b);
  return { limitUSD, thresholds };
}

/** Spend as a percent of the hard limit. A non-positive limit yields 0. */
export function pctOfLimit(spendUSD: number, limitUSD: number): number {
  if (!(limitUSD > 0)) return 0;
  return (spendUSD / limitUSD) * 100;
}
