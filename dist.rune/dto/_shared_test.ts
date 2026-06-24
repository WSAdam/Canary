import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import { assertFetchableUrl, CanaryError, fetchNoSsrfRedirect, requireMaxLength, requireString } from "./_shared.ts";

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
  assertFetchableUrl("http://[2606:4700:4700::1111]/"); // genuine global IPv6 is not blocked
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
    "http://100.64.0.1/", // CGNAT (RFC 6598)
    "http://[::ffff:127.0.0.1]/", // IPv4-mapped IPv6, dotted form
    "http://[::ffff:7f00:1]/", // IPv4-mapped IPv6, hex form Deno normalizes to
    "http://[64:ff9b::7f00:1]/", // NAT64 -> 127.0.0.1
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

Deno.test("assertFetchableUrl - opt-out still enforces the http(s) scheme", () => {
  // The opt-out relaxes only the private-host block, NOT scheme confinement —
  // otherwise file:// would become a local-read primitive on the runner path.
  Deno.env.set("ALLOW_PRIVATE_FETCH", "1");
  try {
    const err = assertThrows(() => assertFetchableUrl("file:///etc/passwd"), CanaryError);
    assertEquals((err as CanaryError).status, 400);
  } finally {
    Deno.env.delete("ALLOW_PRIVATE_FETCH");
  }
});

// fetchNoSsrfRedirect drives the real fetch(), so these run against local stub
// servers under ALLOW_PRIVATE_FETCH=1 (loopback hops must pass the host guard).
Deno.test("fetchNoSsrfRedirect - strips Authorization/Cookie on a cross-origin redirect", async () => {
  Deno.env.set("ALLOW_PRIVATE_FETCH", "1");
  let received: Headers | undefined;
  const dest = Deno.serve({ port: 0, onListen() {} }, (req) => {
    received = req.headers;
    return new Response("ok");
  });
  const src = Deno.serve({ port: 0, onListen() {} }, () =>
    new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${dest.addr.port}/` } }));
  try {
    const res = await fetchNoSsrfRedirect(`http://127.0.0.1:${src.addr.port}/`, {
      headers: { Authorization: "Bearer SECRET", Cookie: "s=1", "X-Custom": "keep" },
    });
    await res.body?.cancel();
    assertEquals(received?.get("authorization"), null); // stripped cross-origin
    assertEquals(received?.get("cookie"), null); // stripped cross-origin
    assertEquals(received?.get("x-custom"), "keep"); // non-sensitive header preserved
  } finally {
    await src.shutdown();
    await dest.shutdown();
    Deno.env.delete("ALLOW_PRIVATE_FETCH");
  }
});

Deno.test("fetchNoSsrfRedirect - keeps Authorization on a same-origin redirect", async () => {
  Deno.env.set("ALLOW_PRIVATE_FETCH", "1");
  let received: Headers | undefined;
  const srv = Deno.serve({ port: 0, onListen() {} }, (req) => {
    if (new URL(req.url).pathname === "/dest") {
      received = req.headers;
      return new Response("ok");
    }
    return new Response(null, { status: 302, headers: { location: "/dest" } });
  });
  try {
    const res = await fetchNoSsrfRedirect(`http://127.0.0.1:${srv.addr.port}/`, {
      headers: { Authorization: "Bearer SECRET" },
    });
    await res.body?.cancel();
    assertEquals(received?.get("authorization"), "Bearer SECRET");
  } finally {
    await srv.shutdown();
    Deno.env.delete("ALLOW_PRIVATE_FETCH");
  }
});

Deno.test("fetchNoSsrfRedirect - throws 502 after too many redirects", async () => {
  Deno.env.set("ALLOW_PRIVATE_FETCH", "1");
  const srv = Deno.serve({ port: 0, onListen() {} }, () =>
    new Response(null, { status: 302, headers: { location: "/loop" } }));
  try {
    const err = await assertRejects(
      () => fetchNoSsrfRedirect(`http://127.0.0.1:${srv.addr.port}/`),
      CanaryError,
    );
    assertEquals((err as CanaryError).status, 502);
  } finally {
    await srv.shutdown();
    Deno.env.delete("ALLOW_PRIVATE_FETCH");
  }
});
