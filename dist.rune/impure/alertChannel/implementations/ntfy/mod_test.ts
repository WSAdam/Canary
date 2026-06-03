import { assertEquals, assertThrows } from "jsr:@std/assert";
import { normalizeNtfyUrl, sanitizeHeaderValue } from "./mod.ts";

Deno.test("normalizeNtfyUrl - bare topic resolves to ntfy.sh", () => {
  assertEquals(normalizeNtfyUrl("alerts"), "https://ntfy.sh/alerts");
});

Deno.test("normalizeNtfyUrl - ntfy.sh/<topic> gets https prefix", () => {
  assertEquals(normalizeNtfyUrl("ntfy.sh/alerts"), "https://ntfy.sh/alerts");
});

Deno.test("normalizeNtfyUrl - full https/http URLs are left unchanged", () => {
  assertEquals(normalizeNtfyUrl("https://ntfy.sh/alerts"), "https://ntfy.sh/alerts");
  assertEquals(normalizeNtfyUrl("http://localhost:8080/alerts"), "http://localhost:8080/alerts");
});

Deno.test("normalizeNtfyUrl - self-hosted host/path gets https prefix", () => {
  assertEquals(normalizeNtfyUrl("ntfy.example.com/team-alerts"), "https://ntfy.example.com/team-alerts");
});

Deno.test("normalizeNtfyUrl - trims surrounding whitespace", () => {
  assertEquals(normalizeNtfyUrl("  alerts  "), "https://ntfy.sh/alerts");
});

Deno.test("normalizeNtfyUrl - throws on empty or whitespace-only", () => {
  assertThrows(() => normalizeNtfyUrl(""));
  assertThrows(() => normalizeNtfyUrl("   "));
});

Deno.test("normalizeNtfyUrl - throws on scheme-only or topic-less input", () => {
  assertThrows(() => normalizeNtfyUrl("https://"));
  assertThrows(() => normalizeNtfyUrl("ntfy.sh/"));
  assertThrows(() => normalizeNtfyUrl("/"));
});

Deno.test("sanitizeHeaderValue - strips control chars (newline, tab, DEL)", () => {
  assertEquals(sanitizeHeaderValue("a\nb"), "ab");
  assertEquals(sanitizeHeaderValue("a\tb\r\nc"), "abc");
  assertEquals(sanitizeHeaderValue("a\x7fb"), "ab");
});

Deno.test("sanitizeHeaderValue - trims and preserves normal + emoji chars", () => {
  assertEquals(sanitizeHeaderValue("  Canary: API FAILED  "), "Canary: API FAILED");
  assertEquals(sanitizeHeaderValue("alert 🔔"), "alert 🔔");
});
