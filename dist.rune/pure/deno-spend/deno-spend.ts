// Parse the Deno Deploy console's tRPC billing payloads into clean numbers.
//
// The console dashboard's billing procedures (console.deno.com/api/
// billing.currentUsageCost / billing.getSpendLimits) return `result.data` as a
// STRING using an unquoted-key serialization — NOT strict JSON — e.g.
//   {total:12.34,items:[{description:"KV Reads (units)",total:5.67}]}
// so it's parsed leniently by regex here rather than JSON.parse. PURE, no I/O.

export interface SpendItem {
  description: string;
  costUSD: number;
}
export interface DenoSpend {
  totalUSD: number;
  items: SpendItem[];
}

/** Parse a `billing.currentUsageCost` data string → grand total + line items.
 *  The FIRST `total:` is the grand total; each `{description:"…",total:N}` is a
 *  billed line (KV reads, egress, …). Throws if no total is present (so a shape
 *  change fails loud instead of silently reporting 0). */
export function parseCurrentUsageCost(dataStr: string): DenoSpend {
  const grand = dataStr.match(/total:\s*(-?[0-9]+(?:\.[0-9]+)?)/);
  if (!grand) throw new Error("currentUsageCost: no 'total' found — billing payload shape changed");
  const totalUSD = Number(grand[1]);
  const items: SpendItem[] = [];
  const re = /\{description:"((?:[^"\\]|\\.)*)",total:\s*(-?[0-9]+(?:\.[0-9]+)?)\}/g;
  for (let m = re.exec(dataStr); m; m = re.exec(dataStr)) {
    items.push({ description: m[1], costUSD: Number(m[2]) });
  }
  return { totalUSD, items };
}

/** Parse a `billing.getSpendLimits` data string (a JSON array like "[140,180,400]").
 *  The hard cap is the max; the smaller values are the configured alert thresholds. */
export function parseSpendLimits(dataStr: string): { limitUSD: number; thresholds: number[] } {
  const arr = JSON.parse(dataStr);
  if (!Array.isArray(arr) || arr.length === 0 || arr.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    throw new Error("getSpendLimits: expected a non-empty number array");
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
