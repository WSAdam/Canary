import type { CheckDto } from "../../dto/check-dto.ts";
import type { ResponseDto } from "../../dto/response-dto.ts";
import { CanaryError } from "../../dto/_shared.ts";

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce((o: unknown, key: string) => {
    if (o === null || o === undefined || typeof o !== "object") return undefined;
    return (o as Record<string, unknown>)[key];
  }, obj);
}

// Sentinel expressions that trigger the robust error-count resolver instead of a
// literal dot-path. Lets a health check read the error count without pinning the
// producer's exact field name (totalErrors vs unrecoveredErrors vs …).
const ERROR_SENTINELS = new Set(["$errors", "$errorcount", "$errorscount"]);

// Known error-count field names, in preference order (the canary contract's
// `totalErrors` first). Matched case-insensitively at any depth.
const ERROR_COUNT_NAMES = [
  "totalErrors", "unrecoveredErrors", "errorCount", "errorsCount",
  "numErrors", "errorTotal", "totalError", "errors",
];
// Array fields whose LENGTH is the count when no numeric field is present
// (e.g. a producer that only returns `errors: [...]`).
const ERROR_ARRAY_NAMES = ["errors", "errorlist", "errorentries", "failures"];
// Guarded fuzzy: a numeric key containing "error" that clearly ISN'T a count
// (a rate/time/threshold/code) must not be mistaken for one — that would let a
// real error count slip by unnoticed.
const NON_COUNT = /rate|ratio|percent|pct|avg|average|mean|median|ms$|sec|time|duration|latency|threshold|limit|code|status|id$/i;

/**
 * Collect, in one shallow-first pass, the first finite-number value and the
 * first array length seen for each (lowercased) key. Shallow keys win over
 * deeper ones so a top-level `totalErrors` beats a nested collision.
 */
function collectKeys(root: unknown): { nums: Map<string, number>; arrs: Map<string, number> } {
  const nums = new Map<string, number>();
  const arrs = new Map<string, number>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const entries = Object.entries(node as Record<string, unknown>);
    for (const [k, v] of entries) {
      const lk = k.toLowerCase();
      if (typeof v === "number" && Number.isFinite(v)) {
        if (!nums.has(lk)) nums.set(lk, v);
      } else if (Array.isArray(v)) {
        if (!arrs.has(lk)) arrs.set(lk, v.length);
      }
    }
    // Descend only after recording this level, so shallower keys take priority.
    for (const [, v] of entries) if (v && typeof v === "object" && !Array.isArray(v)) visit(v);
  };
  visit(root);
  return { nums, arrs };
}

/** Find the error count in a response regardless of the producer's field name:
 *  a known numeric name first, then an errors-style array length, then a guarded
 *  fuzzy match on any error-ish numeric key. Returns undefined if none found. */
function resolveErrorCount(root: unknown): number | undefined {
  const { nums, arrs } = collectKeys(root);
  for (const name of ERROR_COUNT_NAMES) {
    const v = nums.get(name.toLowerCase());
    if (v !== undefined) return v;
  }
  for (const name of ERROR_ARRAY_NAMES) {
    const len = arrs.get(name);
    if (len !== undefined) return len;
  }
  for (const [lk, v] of nums) {
    if (lk.includes("error") && !NON_COUNT.test(lk)) return v;
  }
  return undefined;
}

/** Resolve one candidate to a value: a `$errors` sentinel runs the robust
 *  resolver; anything else is a literal dot-path. */
function resolveCandidate(parsed: unknown, candidate: string): unknown {
  if (ERROR_SENTINELS.has(candidate.toLowerCase())) return resolveErrorCount(parsed);
  return getPath(parsed, candidate);
}

export class Extractor {
  static apply(dto: CheckDto, responseDto: ResponseDto): number {
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseDto.payload);
    } catch {
      throw new CanaryError("extraction-failed", "Response payload is not valid JSON", 422);
    }

    // An expression may list `|`-separated fallbacks (e.g. "totalErrors|unrecoveredErrors")
    // — the first candidate that resolves to a finite number wins. A plain path
    // with no `|` is a single candidate, so existing checks are unaffected.
    const candidates = dto.expression.split("|").map((s) => s.trim()).filter(Boolean);
    for (const candidate of candidates) {
      const value = resolveCandidate(parsed, candidate);
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }

    const usedSentinel = candidates.some((c) => ERROR_SENTINELS.has(c.toLowerCase()));
    // Preserve the original type-aware message for a plain single-path check.
    if (candidates.length === 1 && !usedSentinel) {
      const value = getPath(parsed, candidates[0]);
      throw new CanaryError(
        "extraction-failed",
        `Expression "${dto.expression}" resolved to ${value === undefined ? "undefined" : typeof value}, expected number`,
        422,
      );
    }
    throw new CanaryError(
      "extraction-failed",
      `Expression "${dto.expression}" did not resolve to a number` +
        (usedSentinel
          ? ` (looked for an error count — e.g. ${ERROR_COUNT_NAMES.slice(0, 3).join(", ")}, or an errors[] array — in the response)`
          : ""),
      422,
    );
  }

  static applyCaptures(captures: Record<string, string>, payload: string): Record<string, string> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [name, path] of Object.entries(captures)) {
      const val = getPath(parsed, path);
      // Objects and arrays must be JSON-serialized; String(val) would coerce
      // them to the useless literal "[object Object]". Primitives stay as-is.
      result[name] = val === undefined
        ? ""
        : (typeof val === "object" && val !== null ? JSON.stringify(val) : String(val));
    }
    return result;
  }
}
