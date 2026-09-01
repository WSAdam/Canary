import { assertEquals } from "jsr:@std/assert";
import { COMPRESS_MIN_BYTES, maybeCompress } from "./_compress.ts";

// 2026-09: the SPA shell (134KB) was sent uncompressed on every single load —
// Deno Deploy does not compress for us. These pin that we now gzip what's worth
// gzipping, leave everything else exactly as it was, and never corrupt a body.

const gzipReq = () => new Request("https://x/", { headers: { "Accept-Encoding": "gzip, br" } });
const plainReq = () => new Request("https://x/");

/** A body comfortably over the threshold that actually compresses well. */
const bigHtml = "<!DOCTYPE html><html><body>" + "<p>canary</p>".repeat(400) + "</body></html>";

function htmlRes(body: string) {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function ungzip(res: Response): Promise<string> {
  const stream = new Blob([await res.arrayBuffer() as BlobPart]).stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

Deno.test("maybeCompress - gzips a large text/html body and round-trips it byte-identical", async () => {
  const out = await maybeCompress(gzipReq(), htmlRes(bigHtml));
  assertEquals(out.headers.get("Content-Encoding"), "gzip");
  assertEquals(out.headers.get("Vary"), "Accept-Encoding");
  // The stale uncompressed length must not survive onto a compressed body.
  assertEquals(out.headers.get("Content-Length"), null);
  const bytes = (await out.clone().arrayBuffer()).byteLength;
  assertEquals(bytes < bigHtml.length / 2, true, `expected real compression, got ${bytes}B from ${bigHtml.length}B`);
  assertEquals(await ungzip(out), bigHtml);
});

Deno.test("maybeCompress - gzips a large JSON body", async () => {
  const payload = JSON.stringify({ reports: Array.from({ length: 200 }, (_, i) => ({ id: i, name: "monitor" })) });
  const out = await maybeCompress(gzipReq(), new Response(payload, { headers: { "Content-Type": "application/json" } }));
  assertEquals(out.headers.get("Content-Encoding"), "gzip");
  assertEquals(await ungzip(out), payload);
});

Deno.test("maybeCompress - leaves the body alone when the client did not ask for gzip", async () => {
  const out = await maybeCompress(plainReq(), htmlRes(bigHtml));
  assertEquals(out.headers.get("Content-Encoding"), null);
  assertEquals(await out.text(), bigHtml);
});

Deno.test("maybeCompress - skips bodies under the threshold, and still returns them intact", async () => {
  // Reading the body to measure it consumes the stream; a naive implementation
  // returns an empty response here.
  const small = "<p>hi</p>";
  assertEquals(small.length < COMPRESS_MIN_BYTES, true);
  const out = await maybeCompress(gzipReq(), htmlRes(small));
  assertEquals(out.headers.get("Content-Encoding"), null);
  assertEquals(await out.text(), small);
});

Deno.test("maybeCompress - passes through non-text types and already-encoded bodies", async () => {
  const svg = new Response("x".repeat(4000), { headers: { "Content-Type": "image/svg+xml" } });
  assertEquals((await maybeCompress(gzipReq(), svg)).headers.get("Content-Encoding"), null);

  const already = new Response("x".repeat(4000), {
    headers: { "Content-Type": "text/html", "Content-Encoding": "br" },
  });
  assertEquals((await maybeCompress(gzipReq(), already)).headers.get("Content-Encoding"), "br");
});

Deno.test("maybeCompress - preserves status and other headers", async () => {
  const res = new Response(bigHtml, {
    status: 201,
    headers: { "Content-Type": "text/html", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
  const out = await maybeCompress(gzipReq(), res);
  assertEquals(out.status, 201);
  assertEquals(out.headers.get("Cache-Control"), "no-store");
  assertEquals(out.headers.get("X-Content-Type-Options"), "nosniff");
});

Deno.test("maybeCompress - a bodyless response is passed straight through", async () => {
  const out = await maybeCompress(gzipReq(), new Response(null, { status: 204 }));
  assertEquals(out.status, 204);
  assertEquals(out.headers.get("Content-Encoding"), null);
});
