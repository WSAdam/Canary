// Calendar-day windowing in an arbitrary IANA timezone, DST-correct.
// Ported from autobottom's /canary/errors handler — midnight boundaries avoid
// the 1–3 AM DST-transition ambiguity, and the offset is read at each instant.

/** Offset (ms) of `tz` from UTC at `instant`: (tz wall-clock read as UTC) − instant.
 *  Negative for the Americas (e.g. −4h EDT, −5h EST). */
function tzOffsetMs(instant: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = dtf.formatToParts(new Date(instant));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - instant;
}

/** UTC ms of local midnight (00:00) for the given calendar date in `tz`. */
function midnightUtcMs(y: number, mo: number, d: number, tz: string): number {
  const naive = Date.UTC(y, mo - 1, d, 0, 0, 0);
  return naive - tzOffsetMs(naive, tz);
}

/** Calendar date (Y/M/D) of an instant in `tz`. */
function ymd(instant: number, tz: string): { y: number; mo: number; d: number } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(instant)).split("-").map(Number);
  return { y: p[0], mo: p[1], d: p[2] };
}

const pad = (n: number) => String(n).padStart(2, "0");

export interface DayWindow {
  since: number; // UTC ms, inclusive
  until: number; // UTC ms, exclusive
  date: string; // YYYY-MM-DD of the window's calendar day
}

/** Resolve the [since, until) UTC-ms window for a calendar day in `tz`.
 *  Default = yesterday; `dateStr` (YYYY-MM-DD) overrides to that day. */
export function dayWindow(now: number, tz: string, dateStr?: string): DayWindow {
  let y: number, mo: number, d: number;
  const m = (dateStr ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    y = Number(m[1]);
    mo = Number(m[2]);
    d = Number(m[3]);
  } else {
    // Start of today (tz), step back 12h to land safely in yesterday, read its date.
    const t = ymd(now, tz);
    const todayStart = midnightUtcMs(t.y, t.mo, t.d, tz);
    ({ y, mo, d } = ymd(todayStart - 12 * 3600_000, tz));
  }
  const since = midnightUtcMs(y, mo, d, tz);
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  const until = midnightUtcMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), tz);
  return { since, until, date: `${y}-${pad(mo)}-${pad(d)}` };
}
