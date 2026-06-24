import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { assertFetchableUrl, CanaryError, requireMaxLength, requireString } from "./_shared.ts";

Deno.test("requireString - accepts a non-empty string", () => {
  assertEquals(requireString("hello", "name"), "hello");
});

Deno.test("requireString - rejects missing/empty/non-string with 400", () => {
  for (const bad of [undefined, null, 123, {}, "", "   "]) {
    const err = assertThrows(() => requireString(bad, "name"), CanaryError);
    assertEquals((err as CanaryError).status, 400);
  }
});

Deno.test("requireMaxLength - rejects oversized with 400", () => {
  const err = assertThrows(() => requireMaxLength("abcdef", "x", 3), CanaryError);
  assertEquals((err as CanaryError).status, 400);
  assertEquals(requireMaxLength("ab", "x", 3), "ab");
});

Deno.test("assertFetchableUrl - allows public http(s) hosts", () => {
  assertFetchableUrl("https://example.com/health");
  assertFetchableUrl("http://api.example.org:8080/x");
});

Deno.test("assertFetchableUrl - blocks loopback/link-local/private/metadata hosts", () => {
  const blocked = [
    "http://127.0.0.1/",
    "http://localhost/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://[::1]/",
    "http://metadata.google.internal/",
    "http://service.local/",
  ];
  for (const url of blocked) {
    const err = assertThrows(() => assertFetchableUrl(url), CanaryError, undefined, `expected ${url} blocked`);
    assertEquals((err as CanaryError).status, 400);
  }
});

Deno.test("assertFetchableUrl - rejects non-http schemes", () => {
  const err = assertThrows(() => assertFetchableUrl("file:///etc/passwd"), CanaryError);
  assertEquals((err as CanaryError).status, 400);
});

Deno.test("assertFetchableUrl - honors ALLOW_PRIVATE_FETCH opt-out", () => {
  Deno.env.set("ALLOW_PRIVATE_FETCH", "1");
  try {
    assertFetchableUrl("http://127.0.0.1/"); // should not throw
    assert(true);
  } finally {
    Deno.env.delete("ALLOW_PRIVATE_FETCH");
  }
});
