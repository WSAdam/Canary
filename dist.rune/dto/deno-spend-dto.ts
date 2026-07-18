/** The `/api/deno-spend` response: the org's real usage-based spend and its
 *  live spend limit, read from the Deno console's billing API. Flat fields so a
 *  Canary check extracts `pctOfLimit` (observed) and captures the rest. */
export interface DenoSpendDto {
  ok: true;
  /** Current usage-based spend this cycle, USD (excludes the fixed plan fee). */
  spendUSD: number;
  /** The hard spend limit, read live — so raising it in Deno updates this. */
  limitUSD: number;
  /** spendUSD / limitUSD * 100, rounded. */
  pctOfLimit: number;
  /** The configured alert thresholds below the hard cap, USD. */
  thresholds: number[];
  /** Per-dimension cost breakdown (KV reads, egress, …), USD. */
  items: Array<{ description: string; costUSD: number }>;
  asOf: string;
}
