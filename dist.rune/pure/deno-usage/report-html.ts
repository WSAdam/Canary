// The usage digest as an HTML email body. PURE (no I/O).
//
// Plain-text tables die in Gmail: it renders text/plain in a proportional font,
// so padStart alignment turns to mush. This builds the same report as real HTML
// tables — email-classic markup (table/cellpadding/align/bgcolor + small inline
// styles), which survives Gmail/Apple Mail/Outlook without external CSS.
//
// Size matters: the rendered string travels as a run CAPTURE, and the whole run
// row must stay under Deno KV's per-value limit (the runner budgets 16KB for
// all captures together). Markup here is deliberately terse — attributes over
// inline styles, one style block per repeated concept — and the per-app
// matrices cap their rows. A test pins the byte budget.

import {
  type AppUsage,
  COST_LABELS,
  type DayUsage,
  formatUSD,
  type PerAppSeries,
  TREND_COLUMNS,
  type UsageCost,
} from "./deno-usage.ts";

const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MUTE = "#667";
const RULE = "#ddd";
const ZEBRA = "#f6f6f8";
// Flags the bad state (a partial app's warning marker).
const UP = "#dc2626";

/** Safety valve only: at a realistic org size every row shows. A hundred-app
 *  org still can't blow the capture byte budget through a matrix. */
const MAX_MATRIX_ROWS = 20;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function group(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function section(title: string): string {
  return `<div style='font-size:11px;font-weight:700;color:${MUTE};letter-spacing:.06em;margin:22px 0 8px'>${title}</div>`;
}

function table(inner: string): string {
  return `<table width='100%' cellpadding='5' cellspacing='0' style='border-collapse:collapse;font-size:13px;text-align:right'>${inner}</table>`;
}

function headRow(cells: string[]): string {
  // The rule under the header is ONE divider row, not a border style repeated
  // on every cell — the report is byte-budgeted (see module comment).
  return `<tr style='color:${MUTE};font-size:11px'>` +
    cells.map((c, i) => `<td${i === 0 ? " align=left" : ""}>${c}</td>`).join("") +
    `</tr>` + rule(cells.length);
}

function rule(cols: number): string {
  return `<tr><td colspan='${cols}' style='border-top:1px solid ${RULE};padding:0'></td></tr>`;
}

function bodyRow(cells: string[], i: number, opts?: { bold?: boolean; top?: boolean }): string {
  // Emphasis rows (Total/Average) get a divider row + <b> content rather than a
  // style attribute repeated on every cell — the report is byte-budgeted.
  const cell = (c: string) => (opts?.bold ? `<b>${c}</b>` : c);
  return (opts?.top ? rule(cells.length) : "") +
    `<tr${i % 2 ? ` bgcolor='${ZEBRA}'` : ""}>` +
    cells.map((c, j) => `<td${j === 0 ? " align=left" : ""}>${cell(c)}</td>`).join("") + "</tr>";
}

export interface HtmlReportInput {
  windowLabel: string;
  requests: number;
  kvReadUnits: number;
  kvWriteUnits: number;
  egressGB: number;
  cpuHours: number;
  apps: number;
  appsActive: number;
  /** Active apps only, ranked busiest first. */
  byApp: AppUsage[];
  cost: UsageCost;
  projectedMonthlyUSD: number;
  /** Trailing trend, when requested. */
  series?: DayUsage[];
  perApp?: PerAppSeries[];
}

/** Column headers for the per-app matrices: `Mon<br>13` — short enough for 7
 *  columns, still unambiguous. */
function dayHeads(series: DayUsage[]): string[] {
  return series.map((d) => {
    const [wd, dm] = d.label.split(" "); // "Mon 13/July"
    return `${wd}<br>${dm.split("/")[0]}`;
  });
}

function matrix(title: string, series: DayUsage[], rows: PerAppSeries[], cell: (r: PerAppSeries, i: number) => string, total: (r: PerAppSeries) => string): string {
  const shown = rows.slice(0, MAX_MATRIX_ROWS);
  const more = rows.length - shown.length;
  return section(title) + table(
    headRow(["APP", ...dayHeads(series), "TOTAL"]) +
      shown.map((r, i) =>
        bodyRow(
          [esc(r.app), ...series.map((_, d) => cell(r, d)), `<b>${total(r)}</b>`],
          i,
        )
      ).join("") +
      (more > 0 ? `<tr><td align=left colspan='${series.length + 2}' style='color:${MUTE}'>+${more} more</td></tr>` : ""),
  );
}

/** The digest as a self-contained HTML fragment for Postmark's HtmlBody —
 *  capture it as `{reportHtml}` and make it the whole email message. */
export function buildHtmlReport(input: HtmlReportInput): string {
  const out: string[] = [];
  out.push(`<div style='font-family:${FONT};max-width:720px;margin:0 auto;color:#111827;padding:8px 4px'>`);

  // Header
  out.push(
    `<div style='font-size:19px;font-weight:700;padding-top:8px'>Deno Deploy &mdash; daily usage</div>`,
    `<div style='color:${MUTE};font-size:13px;margin-bottom:14px'>${esc(input.windowLabel)} &nbsp;&middot;&nbsp; ${input.appsActive} of ${input.apps} apps active</div>`,
  );

  // Summary tiles (2 rows of 3 — email-safe, no flexbox)
  const tile = (v: string, l: string) =>
    `<td align=center width=33%><div style='font-size:18px;font-weight:700'>${v}</div><div style='font-size:11px;color:${MUTE};letter-spacing:.05em'>${l}</div></td>`;
  out.push(
    `<table width='100%' cellpadding='9' cellspacing='0' style='border:1px solid ${RULE};border-radius:8px;font-size:13px'>` +
      `<tr>${tile(group(input.requests), "REQUESTS")}${tile(group(input.kvReadUnits), "KV READS")}${tile(group(input.kvWriteUnits), "KV WRITES")}</tr>` +
      `<tr>${tile(input.egressGB + " GB", "EGRESS")}${tile(input.cpuHours + " h", "CPU")}${tile(formatUSD(input.cost.totalUSD, 2), "COST")}</tr>` +
      `</table>`,
  );

  // By app — the reporting day
  out.push(
    section("BY APP"),
    table(
      headRow(["APP", "REQUESTS", "KV READS", "KV WRITES", "COST"]) +
        input.byApp.map((a, i) =>
          bodyRow([
            esc(a.app) + (a.errored ? ` <span style='color:${UP}'>&#9888; partial</span>` : ""),
            group(a.requests),
            group(a.kvReadUnits),
            group(a.kvWriteUnits),
            `<b>${formatUSD(a.costUSD, 3)}</b>`,
          ], i)
        ).join("") +
        (input.apps - input.byApp.length > 0
          ? `<tr><td align=left colspan='5' style='color:${MUTE}'>+${input.apps - input.byApp.length} idle</td></tr>`
          : ""),
    ),
  );

  // Cost split
  out.push(
    section("COST &mdash; METERED USAGE AT LIST RATE"),
    table(
      COST_LABELS.filter(([m]) => input.cost.byMetric[m] > 0)
        .map(([m, label], i) => bodyRow([label, formatUSD(input.cost.byMetric[m], 3)], i)).join("") +
        bodyRow(["Total", formatUSD(input.cost.totalUSD, 2)], 0, { bold: true, top: true }),
    ),
    `<div style='font-size:13px;margin-top:6px'>&asymp; <b>${formatUSD(input.projectedMonthlyUSD, 2)}/month</b> at this rate</div>`,
    `<div style='font-size:11px;color:${MUTE};margin-top:4px'>Excludes the plan fee and any provisioned database/storage; ignores monthly included allotments &mdash; attribution, not billing.</div>`,
  );

  // Trailing trend
  if (input.series && input.series.length > 0) {
    const s = input.series;
    const totals = TREND_COLUMNS.map((c) => s.reduce((a, d) => a + d[c.key], 0));
    out.push(
      section(`TRAILING ${s.length} DAYS`),
      table(
        headRow(["DAY", ...TREND_COLUMNS.map((c) => c.label.toUpperCase())]) +
          s.map((d, i) => bodyRow([d.label, ...TREND_COLUMNS.map((c) => group(d[c.key]))], i)).join("") +
          bodyRow(["Total", ...totals.map(group)], 0, { bold: true, top: true }) +
          bodyRow(["Average", ...totals.map((t) => group(t / s.length))], 1, { bold: true }),
      ),
    );
    // Per-app matrices — KV reads and writes (only the apps that touch KV, each
    // ranked by its own metric), then cost for every active app (cost folds
    // KV/egress/CPU into one comparable number per app-day, so a regression
    // shows even when request counts look normal). Per-app requests stay in the
    // JSON (trailing.perApp) for anyone who wants them.
    if (input.perApp && input.perApp.length > 0) {
      const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
      const kvRows = (pick: (r: PerAppSeries) => number[]) =>
        input.perApp!.filter((r) => pick(r).some((n) => n > 0))
          .sort((a, b) => sum(pick(b)) - sum(pick(a)) || a.app.localeCompare(b.app));
      const reads = kvRows((r) => r.kvReadUnits);
      const writes = kvRows((r) => r.kvWriteUnits);
      if (reads.length > 0) {
        out.push(matrix("KV READS BY APP", s, reads, (r, d) => group(r.kvReadUnits[d]), (r) => group(sum(r.kvReadUnits))));
      }
      if (writes.length > 0) {
        out.push(matrix("KV WRITES BY APP", s, writes, (r, d) => group(r.kvWriteUnits[d]), (r) => group(sum(r.kvWriteUnits))));
      }
      out.push(matrix("COST BY APP", s, input.perApp, (r, d) => formatUSD(r.costUSD[d], 2), (r) => formatUSD(r.totalCostUSD, 2)));
    }
  }

  out.push(`</div>`);
  return out.join("");
}
