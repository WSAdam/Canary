import { assertEquals } from "jsr:@std/assert@^1";
import { CanaryReporter, dayWindow, memoryStore } from "./mod.ts";

const TZ = "America/New_York";

Deno.test("dayWindow - default is yesterday (ET), one full day, DST-correct", () => {
  // 2026-06-03 19:00 UTC = 15:00 EDT (UTC-4)
  const now = Date.UTC(2026, 5, 3, 19, 0, 0);
  const w = dayWindow(now, TZ);
  assertEquals(w.date, "2026-06-02");
  assertEquals(w.since, Date.UTC(2026, 5, 2, 4, 0, 0)); // ET midnight = 04:00 UTC in June
  assertEquals(w.until, Date.UTC(2026, 5, 3, 4, 0, 0));
  assertEquals(w.until - w.since, 86_400_000);
});

Deno.test("dayWindow - explicit date override", () => {
  const w = dayWindow(Date.UTC(2026, 5, 3, 19, 0, 0), TZ, "2026-06-03");
  assertEquals(w.date, "2026-06-03");
  assertEquals(w.since, Date.UTC(2026, 5, 3, 4, 0, 0));
  assertEquals(w.until, Date.UTC(2026, 5, 4, 4, 0, 0));
});

Deno.test("trackError + getErrorsInWindow - records land in the window, others filtered", async () => {
  const r = new CanaryReporter({ secret: "x", store: memoryStore() });
  await r.trackError("checkout", "boom", { ref: "order_1" });
  await r.trackError("checkout", "bang");
  const now = Date.now();
  assertEquals((await r.getErrorsInWindow(now - 5_000, now + 5_000)).length, 2);
  assertEquals((await r.getErrorsInWindow(0, 1_000)).length, 0);
});

Deno.test("handleErrors - rejects non-POST and bad bearer", async () => {
  const r = new CanaryReporter({ secret: "s3cr3t", store: memoryStore() });
  assertEquals((await r.handleErrors(new Request("https://x/canary/errors"))).status, 405);
  assertEquals(
    (await r.handleErrors(new Request("https://x/canary/errors", { method: "POST" }))).status,
    401,
  );
  assertEquals(
    (await r.handleErrors(new Request("https://x/canary/errors", {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
    }))).status,
    401,
  );
});

Deno.test("handleErrors - healthy report is totalErrors:0, errors surface in their day", async () => {
  const r = new CanaryReporter({ secret: "s3cr3t", store: memoryStore() });
  const auth = { Authorization: "Bearer s3cr3t" };

  // Yesterday's window is empty → healthy.
  const healthy = await (await r.handleErrors(
    new Request("https://x/canary/errors", { method: "POST", headers: auth }),
  )).json();
  assertEquals(healthy.ok, true);
  assertEquals(healthy.totalErrors, 0);
  assertEquals(healthy.timezone, TZ);

  // Record one now, then query today's window via ?date override.
  await r.trackError("init", "The signal has been aborted", { ref: "abc123" });
  const todayET = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
  const report = await (await r.handleErrors(
    new Request("https://x/canary/errors?date=" + todayET, { method: "POST", headers: auth }),
  )).json();
  assertEquals(report.totalErrors, 1);
  assertEquals(report.refs, ["abc123"]);
  assertEquals(report.errors[0].step, "init");
  assertEquals(report.errors[0].error, "The signal has been aborted");
  assertEquals(typeof report.errors[0].timestamp, "string");
});
