import { assertEquals, assertThrows } from "jsr:@std/assert";
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
