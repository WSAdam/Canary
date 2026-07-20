import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  dayKey,
  dayLabel,
  formatDisplay,
  formatRange,
  localDay,
  parseBoundary,
  resolveWindow,
  trailingDays,
  zonedToInstant,
} from "./time-window.ts";

// July → EDT (UTC-4). January → EST (UTC-5). Both are exercised so a DST bug
// can't hide behind a single season.

Deno.test("formatDisplay - HH:MM DD/Month/YYYY in Eastern, summer (EDT)", () => {
  // 15:45 UTC on 19 July 2026 is 11:45 EDT.
  assertEquals(formatDisplay(new Date("2026-07-19T15:45:58.092Z")), "11:45 19/July/2026 EDT");
});

Deno.test("formatDisplay - winter reads EST, not EDT", () => {
  assertEquals(formatDisplay(new Date("2026-01-15T15:45:00Z")), "10:45 15/January/2026 EST");
});

Deno.test("formatDisplay - a UTC instant that is the PREVIOUS day in Eastern", () => {
  // 02:30 UTC on the 20th is 22:30 on the 19th in EDT.
  assertEquals(formatDisplay(new Date("2026-07-20T02:30:00Z")), "22:30 19/July/2026 EDT");
});

Deno.test("zonedToInstant - Eastern wall-clock maps to the right UTC instant", () => {
  // Midnight EDT on 19 July 2026 == 04:00 UTC.
  assertEquals(zonedToInstant(2026, 7, 19, 0, 0).toISOString(), "2026-07-19T04:00:00.000Z");
  // Midnight EST in January == 05:00 UTC.
  assertEquals(zonedToInstant(2026, 1, 15, 0, 0).toISOString(), "2026-01-15T05:00:00.000Z");
});

Deno.test("zonedToInstant - round-trips through formatDisplay", () => {
  const inst = zonedToInstant(2026, 7, 19, 12, 1);
  assertEquals(formatDisplay(inst), "12:01 19/July/2026 EDT");
});

Deno.test("zonedToInstant - survives the spring-forward boundary", () => {
  // DST begins 08 March 2026 at 02:00 EST → 03:00 EDT. A time after the jump
  // must resolve on the EDT (UTC-4) side.
  assertEquals(zonedToInstant(2026, 3, 8, 12, 0).toISOString(), "2026-03-08T16:00:00.000Z");
  // The day before is still EST (UTC-5).
  assertEquals(zonedToInstant(2026, 3, 7, 12, 0).toISOString(), "2026-03-07T17:00:00.000Z");
});

Deno.test("formatRange - collapses the date when both ends share a local day", () => {
  const { since, until } = localDay(new Date("2026-07-20T15:45:00Z"), 1);
  assertEquals(formatRange(since, until), "19/July/2026 00:00 → 23:59 EDT");
});

Deno.test("formatRange - keeps both dates when the window crosses midnight", () => {
  const since = new Date("2026-07-19T15:45:00Z");
  const until = new Date("2026-07-20T15:45:00Z");
  assertEquals(formatRange(since, until), "19/July/2026 11:45 → 20/July/2026 11:45 EDT");
});

Deno.test("localDay - yesterday spans exactly one local day", () => {
  const { since, until } = localDay(new Date("2026-07-20T15:45:00Z"), 1);
  assertEquals(since.toISOString(), "2026-07-19T04:00:00.000Z"); // 00:00 EDT
  assertEquals(until.toISOString(), "2026-07-20T03:59:59.999Z"); // 23:59:59.999 EDT
  // Exactly 24h, to the millisecond.
  assertEquals(until.getTime() - since.getTime(), 86_400_000 - 1);
});

Deno.test("localDay - today starts at local midnight and stops at now", () => {
  const now = new Date("2026-07-20T15:45:00Z"); // 11:45 EDT
  const w = localDay(now, 0);
  assertEquals(w.since.toISOString(), "2026-07-20T04:00:00.000Z"); // 00:00 EDT
  // A day in progress must NOT claim the hours that haven't happened yet.
  assertEquals(w.until.getTime(), now.getTime());
  assertEquals(formatRange(w.since, w.until), "20/July/2026 00:00 → 11:45 EDT");
});

Deno.test("localDay - a COMPLETED day is not clamped", () => {
  // Yesterday has fully elapsed, so it keeps its true 23:59:59.999 end.
  const w = localDay(new Date("2026-07-20T15:45:00Z"), 1);
  assertEquals(w.until.toISOString(), "2026-07-20T03:59:59.999Z");
});

Deno.test("localDay - a UTC instant already past midnight ET picks the right day", () => {
  // 02:00 UTC on the 20th is still the 19th in Eastern, so "yesterday" is the 18th.
  const { since } = localDay(new Date("2026-07-20T02:00:00Z"), 1);
  assertEquals(formatDisplay(since), "00:00 18/July/2026 EDT");
});

Deno.test("parseBoundary - a bare date is Eastern midnight, not UTC", () => {
  assertEquals(parseBoundary("2026-07-19", "from").toISOString(), "2026-07-19T04:00:00.000Z");
});

Deno.test("parseBoundary - date+time is read as Eastern wall-clock", () => {
  assertEquals(parseBoundary("2026-07-19 12:01", "from").toISOString(), "2026-07-19T16:01:00.000Z");
  assertEquals(parseBoundary("2026-07-19T23:59:59", "to").toISOString(), "2026-07-20T03:59:59.000Z");
});

Deno.test("parseBoundary - an explicit Z/offset is honoured as written", () => {
  assertEquals(parseBoundary("2026-07-19T12:01:00Z", "from").toISOString(), "2026-07-19T12:01:00.000Z");
  assertEquals(parseBoundary("2026-07-19T12:01:00-07:00", "from").toISOString(), "2026-07-19T19:01:00.000Z");
});

Deno.test("parseBoundary - rejects nonsense and names the field", () => {
  const err = assertThrows(() => parseBoundary("last tuesday", "from")) as Error;
  assertEquals(err.message.includes("from"), true);
});

Deno.test("resolveWindow - defaults to a rolling 24h", () => {
  const now = new Date("2026-07-20T15:45:00Z");
  const w = resolveWindow(new URLSearchParams(), now);
  assertEquals(w.until.getTime(), now.getTime());
  assertEquals(w.until.getTime() - w.since.getTime(), 86_400_000);
});

Deno.test("resolveWindow - honours ?hours= and falls back on a bad value", () => {
  const now = new Date("2026-07-20T15:45:00Z");
  assertEquals(resolveWindow(new URLSearchParams("hours=6"), now).until.getTime() -
    resolveWindow(new URLSearchParams("hours=6"), now).since.getTime(), 6 * 3_600_000);
  // Out of range / non-numeric → the 24h default rather than an error.
  assertEquals(resolveWindow(new URLSearchParams("hours=0"), now).until.getTime() -
    resolveWindow(new URLSearchParams("hours=0"), now).since.getTime(), 86_400_000);
  assertEquals(resolveWindow(new URLSearchParams("hours=abc"), now).until.getTime() -
    resolveWindow(new URLSearchParams("hours=abc"), now).since.getTime(), 86_400_000);
});

Deno.test("resolveWindow - ?day=yesterday wins over ?hours=", () => {
  const now = new Date("2026-07-20T15:45:00Z");
  const w = resolveWindow(new URLSearchParams("day=yesterday&hours=6"), now);
  assertEquals(formatRange(w.since, w.until), "19/July/2026 00:00 → 23:59 EDT");
});

Deno.test("resolveWindow - ?day= is case/space tolerant and rejects unknown values", () => {
  const now = new Date("2026-07-20T15:45:00Z");
  assertEquals(resolveWindow(new URLSearchParams("day= YESTERDAY "), now).since.toISOString(), "2026-07-19T04:00:00.000Z");
  assertThrows(() => resolveWindow(new URLSearchParams("day=tomorrow"), now));
});

Deno.test("resolveWindow - explicit from/to in Eastern", () => {
  const now = new Date("2026-07-20T15:45:00Z");
  const w = resolveWindow(new URLSearchParams("from=2026-07-19 00:01&to=2026-07-19 23:59"), now);
  assertEquals(formatRange(w.since, w.until), "19/July/2026 00:01 → 23:59 EDT");
});

Deno.test("resolveWindow - from/to must be given together, and in order", () => {
  const now = new Date("2026-07-20T15:45:00Z");
  assertThrows(() => resolveWindow(new URLSearchParams("from=2026-07-19"), now));
  assertThrows(() => resolveWindow(new URLSearchParams("to=2026-07-19"), now));
  assertThrows(() => resolveWindow(new URLSearchParams("from=2026-07-19&to=2026-07-18"), now));
  // Equal bounds is an empty window, not a valid one.
  assertThrows(() => resolveWindow(new URLSearchParams("from=2026-07-19&to=2026-07-19"), now));
});

Deno.test("resolveWindow - rejects an absurdly long window", () => {
  const now = new Date("2026-07-20T15:45:00Z");
  assertThrows(() => resolveWindow(new URLSearchParams("from=2020-01-01&to=2026-01-01"), now));
});

Deno.test("trailingDays - ENDS on the reporting day, oldest first", () => {
  // The digest anchors on its window's `until`. For ?day=yesterday reporting the
  // 19th, `until` is 23:59:59.999 EDT on the 19th (= 03:59:59.999Z on the 20th).
  // The series must END on the 19th — the day being compared against the rest.
  const until = new Date("2026-07-20T03:59:59.999Z");
  const days = trailingDays(until, 7);
  assertEquals(days.length, 7);
  assertEquals(days[0].key, "2026-07-13", "oldest first");
  assertEquals(days[6].key, "2026-07-19", "the reporting day is the LAST row");
  assertEquals(days[6].label, "Sun 19/July");
});

Deno.test("trailingDays - the reporting day's window matches localDay for it", () => {
  const until = new Date("2026-07-20T03:59:59.999Z");
  const last = trailingDays(until, 7)[6];
  const expected = localDay(until, 0);
  assertEquals(last.since.toISOString(), expected.since.toISOString());
  assertEquals(last.until.toISOString(), expected.until.toISOString());
});

Deno.test("trailingDays - endOffset 1 ends the day before", () => {
  const days = trailingDays(new Date("2026-07-20T03:59:59.999Z"), 3, 1);
  assertEquals(days.map((d) => d.key), ["2026-07-16", "2026-07-17", "2026-07-18"]);
});

Deno.test("dayKey / dayLabel - local date, not UTC date", () => {
  // 02:00Z on the 20th is 22:00 EDT on the 19th.
  const inst = new Date("2026-07-20T02:00:00Z");
  assertEquals(dayKey(inst), "2026-07-19");
  assertEquals(dayLabel(inst), "Sun 19/July");
});
