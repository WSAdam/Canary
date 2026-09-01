// ---------------------------------------------------------------------------
// Response compression
// ---------------------------------------------------------------------------
// Deno Deploy does not compress responses for us (deno.com's own pages come back
// uncompressed too), so the 134KB SPA shell was re-sent in full on every load.
// It gzips to ~33KB — a 76% cut — and the 30-day reports payload goes 450KB → ~67KB.
// Applied at a single choke point around the request handler rather than at ~50
// json() call sites.

// Below this, the gzip header and CPU cost more than the bytes saved.
export const COMPRESS_MIN_BYTES = 1500;

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function acceptsGzip(req: Request): boolean {
  return (req.headers.get("Accept-Encoding") ?? "").toLowerCase().includes("gzip");
}

/**
 * Gzip a response when the client asked for it, the body is worth compressing,
 * and the type is text-shaped. Anything already encoded, streamed, or empty is
 * passed straight through untouched.
 */
export async function maybeCompress(req: Request, res: Response): Promise<Response> {
  if (!acceptsGzip(req) || res.headers.has("Content-Encoding") || !res.body) return res;
  const type = res.headers.get("Content-Type") ?? "";
  if (!/^(text\/|application\/(json|javascript))/i.test(type)) return res;

  const raw = new Uint8Array(await res.arrayBuffer());
  if (raw.byteLength < COMPRESS_MIN_BYTES) {
    // Re-wrap: the body was consumed reading it.
    return new Response(raw, { status: res.status, headers: res.headers });
  }

  // Deliberately NOT cached by content-type: gzipping the 134KB shell measures
  // at ~1.7ms, and a cache keyed on "is this text/html" would hand the shell's
  // bytes to any second HTML response added later. Not worth the trap.
  const body = await gzip(raw);

  const headers = new Headers(res.headers);
  headers.set("Content-Encoding", "gzip");
  // Caches and proxies must key on the encoding, not just the URL.
  headers.append("Vary", "Accept-Encoding");
  // Stale: it describes the uncompressed body. Response recomputes it.
  headers.delete("Content-Length");
  return new Response(body as BodyInit, { status: res.status, headers });
}
