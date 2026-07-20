import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import { normalizeLogsUrl } from "./check-configure.ts";

Deno.test("normalizeLogsUrl - omitted/blank normalizes to unset", () => {
  assertEquals(normalizeLogsUrl(undefined), undefined);
  assertEquals(normalizeLogsUrl(""), undefined);
  assertEquals(normalizeLogsUrl("   "), undefined);
});

Deno.test("normalizeLogsUrl - accepts an http(s) URL and returns the canonical href", () => {
  assertEquals(normalizeLogsUrl("https://dash.deno.com/projects/app/logs"), "https://dash.deno.com/projects/app/logs");
  // Canonicalization adds the empty path — proves we store parsed.href, not raw.
  assertEquals(normalizeLogsUrl("http://example.com"), "http://example.com/");
});

Deno.test("normalizeLogsUrl - rejects a non-http(s) scheme (no javascript:/data:/ftp:)", () => {
  assertThrows(() => normalizeLogsUrl("javascript:alert(1)"));
  assertThrows(() => normalizeLogsUrl("ftp://example.com/x"));
});

Deno.test("normalizeLogsUrl - rejects a non-string and an unparseable value", () => {
  assertThrows(() => normalizeLogsUrl(123));
  assertThrows(() => normalizeLogsUrl("not a url"));
});

Deno.test("normalizeLogsUrl - rejects an over-long URL (SMS-segment / KV-limit guard)", () => {
  assertThrows(() => normalizeLogsUrl("https://x.com/" + "a".repeat(3000)));
});

Deno.test("normalizeLogsUrl - strips CR/LF the URL parser tolerates (no header-injection residue)", () => {
  const out = normalizeLogsUrl("https://x.com/\r\nSet-Cookie: y")!;
  assertEquals(out.includes("\r"), false);
  assertEquals(out.includes("\n"), false);
});

// --- report mode -------------------------------------------------------------

import { configureCheck } from "./check-configure.ts";
import { createMonitor } from "../monitor-create/monitor-create.ts";
import type { ConfigureCheckDto } from "../../dto/configure-check-dto.ts";

async function freshMonitorId(): Promise<string> {
  const m = await createMonitor({ name: "report-mode-" + crypto.randomUUID().slice(0, 8), description: "t" });
  return m.monitorId;
}

const BASE_CHECK = {
  url: "https://example.com/api",
  method: "GET",
  headers: {},
  cron: "0 9 * * *",
  notifyOnRecover: false,
} as Omit<ConfigureCheckDto, "monitorId" | "expression" | "comparatorOp" | "threshold">;

Deno.test("configureCheck - report mode needs no expression/comparator/threshold", async () => {
  const monitorId = await freshMonitorId();
  // Deliberately no expression, comparatorOp, or threshold — the fields the
  // wizard hides in report mode. Must save cleanly, not 400.
  const dto = await configureCheck({ ...BASE_CHECK, monitorId, reportOnly: true } as unknown as ConfigureCheckDto);
  assertEquals(dto.reportOnly, true);
  // The mode's whole point: it always sends.
  assertEquals(dto.notifyOnSuccess, true);
  // Comparator fields are stored as inert placeholders, never evaluated.
  assertEquals(dto.comparatorOp, "gte");
  assertEquals(dto.threshold, 0);
});

Deno.test("configureCheck - report mode keeps captures (the report's data path)", async () => {
  const monitorId = await freshMonitorId();
  const dto = await configureCheck(
    { ...BASE_CHECK, monitorId, reportOnly: true, captures: { report: "report" } } as unknown as ConfigureCheckDto,
  );
  assertEquals(dto.captures, { report: "report" });
});

Deno.test("configureCheck - a normal check still requires the comparator trio", async () => {
  const monitorId = await freshMonitorId();
  // Without reportOnly the old contract holds: missing expression → 400.
  await assertRejects(() => configureCheck({ ...BASE_CHECK, monitorId } as unknown as ConfigureCheckDto));
});

Deno.test("configureCheck - rejects a non-boolean reportOnly", async () => {
  const monitorId = await freshMonitorId();
  await assertRejects(() =>
    configureCheck(
      { ...BASE_CHECK, monitorId, expression: "x", comparatorOp: "gt", threshold: 1, reportOnly: "yes" } as unknown as ConfigureCheckDto,
    )
  );
});

Deno.test("configureCheck - report mode does not force notifyOnSuccess OFF elsewhere", async () => {
  const monitorId = await freshMonitorId();
  // A normal check with notifyOnSuccess explicitly false stays false.
  const dto = await configureCheck(
    { ...BASE_CHECK, monitorId, expression: "x", comparatorOp: "gt", threshold: 1, notifyOnSuccess: false } as ConfigureCheckDto,
  );
  assertEquals(dto.reportOnly, false);
  assertEquals(dto.notifyOnSuccess, false);
});
