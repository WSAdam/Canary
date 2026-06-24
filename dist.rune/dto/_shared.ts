export class CanaryError extends Error {
  constructor(
    public readonly fault: string,
    message: string,
    public readonly status: number = 500,
  ) {
    super(message);
    this.name = "CanaryError";
  }
}

/**
 * Optional upstream-response detail attached to errors thrown by HTTP sources
 * on a non-2xx response, so a failed run can persist what the endpoint actually
 * returned (status + body) rather than discarding it.
 */
export interface ResponseDetailCarrier {
  responseStatus?: number;
  responseBody?: string;
}

/**
 * Require a present, non-empty (after trim) string field on a request body,
 * throwing a uniform CanaryError(validation-error, 400) when it is missing,
 * the wrong type, or blank. Centralizes the "malformed input → 400, not a raw
 * KV TypeError → 500" guard used across the API surface.
 */
export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CanaryError("validation-error", `${field} is required and must be a non-empty string`, 400);
  }
  return value;
}

/**
 * Enforce a maximum length (in characters) on a request field, throwing a
 * uniform 400 instead of letting an oversized value hit a downstream limit
 * (e.g. Deno KV's key/value size caps) as an opaque 500.
 */
export function requireMaxLength(value: string, field: string, max: number): string {
  if (value.length > max) {
    throw new CanaryError("validation-error", `${field} must be at most ${max} characters`, 400);
  }
  return value;
}

/**
 * Map an upstream channel HTTP status to our error status: a 4xx is a
 * client/config error (surface 400), anything else is an upstream fault (502).
 * Shared by the email/SMS/ntfy channels so the policy can't drift between them.
 */
export function upstreamStatus(httpStatus: number): number {
  return httpStatus >= 400 && httpStatus < 500 ? 400 : 502;
}

/**
 * SSRF guard for any URL the server will fetch on a caller's behalf (the
 * check runner and the /test-request proxy). Enforces an http(s) scheme and
 * rejects hosts that resolve to loopback/link-local/private space or the cloud
 * metadata endpoint, so an authenticated user can't turn the server into a
 * read primitive against the deployment's internal network.
 *
 * Set ALLOW_PRIVATE_FETCH=1 to disable (e.g. monitoring an internal service on
 * a trusted private network) — off by default so the safe path is the default.
 *
 * RESIDUAL RISK (DNS rebinding): this guard validates the URL's literal
 * hostname only. A public DNS name that resolves (or, via a TTL-0 rebind after
 * this check, re-resolves) to a private/loopback/metadata IP still passes,
 * because Deno's fetch() performs name resolution internally and does not
 * expose the resolved IP for pre-connect validation or pinning. Closing this
 * fully requires resolving the host and validating every resolved A/AAAA record
 * at connect time (not available here), so prefer an explicit allowlist of
 * monitored hosts where the threat model demands it.
 */
export function assertFetchableUrl(rawUrl: string): void {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    throw new CanaryError("validation-error", "url is required", 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new CanaryError("validation-error", `Invalid URL: "${rawUrl}"`, 400);
  }
  // Scheme confinement is enforced UNCONDITIONALLY. ALLOW_PRIVATE_FETCH relaxes
  // only the private-host block below — never the http(s) requirement, or the
  // opt-out would become a file:// local-read primitive on the runner path.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CanaryError("validation-error", `Only http(s) URLs are allowed, got "${parsed.protocol}"`, 400);
  }
  if (globalThis.Deno?.env.get("ALLOW_PRIVATE_FETCH") === "1") return;
  if (isBlockedHost(parsed.hostname)) {
    throw new CanaryError(
      "validation-error",
      `URL host "${parsed.hostname}" is not allowed (loopback/link-local/private/metadata address)`,
      400,
    );
  }
}

/**
 * SSRF-safe fetch: like the global fetch(), but follows redirects MANUALLY and
 * re-runs assertFetchableUrl() on every hop's Location. The platform's default
 * `redirect: "follow"` would silently chase a 3xx from an attacker-controlled
 * public host to an internal/metadata address (169.254.169.254, 127.0.0.1, …),
 * defeating the guard — it only ever validated the literal URL the caller gave.
 * Resolve relative Locations against the current URL before validating.
 */
export async function fetchNoSsrfRedirect(
  input: string,
  init: RequestInit = {},
  maxRedirects = 5,
): Promise<Response> {
  // Headers the Fetch spec strips when redirect:"follow" crosses to a different
  // origin. Because we follow redirects MANUALLY (to re-check each hop's host for
  // SSRF), we must replicate that stripping ourselves — otherwise a monitored
  // endpoint that 3xx-redirects to another origin would receive the caller's
  // Authorization/Cookie (e.g. a resolved {{SECRET}} bearer token), turning the
  // SSRF fix into a credential-exfiltration path.
  const SENSITIVE_ON_CROSS_ORIGIN = ["authorization", "cookie", "proxy-authorization"];
  let current = input;
  const headers = new Headers(init.headers);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    assertFetchableUrl(current);
    const res = await fetch(current, { ...init, headers, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      const location = res.headers.get("location")!;
      // Drain the redirect body so the connection can be reused/closed.
      await res.body?.cancel();
      const next = new URL(location, current).toString();
      // Cross-origin hop → drop sensitive headers before following, matching the
      // platform's redirect:"follow" behavior. Once dropped they stay dropped.
      if (new URL(next).origin !== new URL(current).origin) {
        for (const h of SENSITIVE_ON_CROSS_ORIGIN) headers.delete(h);
      }
      current = next;
      continue;
    }
    return res;
  }
  throw new CanaryError("request-failed", `Too many redirects (>${maxRedirects})`, 502);
}

function isBlockedHost(hostRaw: string): boolean {
  // URL.hostname keeps the [brackets] around an IPv6 literal — strip them.
  // Lowercase and trim a trailing dot (FQDN form) too.
  const host = hostRaw.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  // Cloud instance-metadata endpoints.
  if (host === "169.254.169.254" || host === "metadata.google.internal") return true;

  // IPv4 literal → block loopback (127/8), link-local (169.254/16), and RFC1918.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])];
    // \d{1,3} matches 0-999; a quad with an octet >255 isn't a real IPv4 literal,
    // so treat it as a (non-private) hostname rather than misclassifying it.
    if (octets.some((o) => o > 255)) return false;
    const [a, b] = octets;
    if (a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT, RFC 6598 (100.64.0.0/10)
    if (a === 0) return true;
    return false;
  }

  // IPv6 literal → block loopback (::1), unspecified (::), unique-local (fc00::/7),
  // and link-local (fe80::/10).
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;     // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true;     // fe80::/10
    // IPv4-mapped IPv6 in dotted form (::ffff:127.0.0.1) — recurse on the v4.
    const mappedDotted = host.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mappedDotted) return isBlockedHost(mappedDotted[1]);
    // Deno's URL parser normalizes the bracketed mapped form to the HEX-compressed
    // representation, e.g. http://[::ffff:127.0.0.1]/ → [::ffff:7f00:1]. The dotted
    // regex above never fires on that, so decode the embedded v4 from the trailing
    // 32 bits and recurse. Covers ::ffff:7f00:1 (IPv4-mapped), the fully expanded
    // 0:0:0:0:0:ffff:7f00:1, and the NAT64 prefix 64:ff9b::/96 — all of which
    // fetch() will connect to as the underlying IPv4 address on a dual-stack host.
    const v4 = embeddedV4FromIpv6(host);
    if (v4) return isBlockedHost(v4);
    return false;
  }

  return false;
}

/**
 * Decode the IPv4 address embedded in the trailing 32 bits of an IPv6 literal
 * for the IPv4-mapped (::ffff:0:0/96) and NAT64 translation (64:ff9b::/96)
 * prefixes, returning it in dotted-decimal form. Returns null when the host is
 * not one of those embedding forms. We deliberately scope this to the known
 * v4-embedding prefixes so a normal global IPv6 address isn't misread as v4.
 */
function embeddedV4FromIpv6(host: string): string | null {
  // Normalize "::" expansion so the groups line up, then read the last two
  // 16-bit hex groups as the 32-bit v4. Only do this for the mapped/NAT64
  // prefixes to avoid false positives on ordinary IPv6.
  const isMapped = /(^|:)0*:?0*ffff:/.test(host) || host.includes(":ffff:");
  const isNat64 = /^64:ff9b::/.test(host);
  if (!isMapped && !isNat64) return null;

  const groups = expandIpv6(host);
  if (!groups) return null;
  // For ::ffff:a.b.c.d the mapped marker (ffff) sits in group index 5.
  if (isMapped && groups[5] !== 0xffff) return null;
  const hi = groups[6];
  const lo = groups[7];
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/** Expand an IPv6 literal (already lowercased, brackets stripped) into its 8
 *  16-bit groups, or null if it isn't a parseable hextet form. A trailing
 *  dotted-quad is intentionally NOT handled here (the dotted regex covers it). */
function expandIpv6(host: string): number[] | null {
  if (host.includes(".")) return null; // dotted tail handled elsewhere
  const parts = host.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 ? (parts[1] ? parts[1].split(":") : []) : [];
  const fill = 8 - (head.length + tail.length);
  if (parts.length === 1) {
    if (head.length !== 8) return null;
  } else if (fill < 0) {
    return null;
  }
  const all = parts.length === 2
    ? [...head, ...Array(fill).fill("0"), ...tail]
    : head;
  if (all.length !== 8) return null;
  const groups: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    groups.push(parseInt(g, 16));
  }
  return groups;
}

/**
 * Constant-time string comparison for secret/hash material. The length check
 * leaks length only, which is fine for fixed-length hex/base64 digests.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
