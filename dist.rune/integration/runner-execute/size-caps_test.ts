import { assert, assertEquals } from "jsr:@std/assert";
import { byteLen, truncateBody } from "./runner-execute.ts";

// Deno KV's per-value limit is on serialized UTF-8 BYTES, not JS string length
// (UTF-16 code units). These guard against the regression where multi-byte
// content passed a .length check and still overflowed the persisted run row.

Deno.test("byteLen counts UTF-8 bytes, not UTF-16 code units", () => {
  assertEquals(byteLen("abc"), 3);
  assertEquals(byteLen("中"), 3); // CJK: 1 code unit, 3 bytes
  assertEquals(byteLen("😀"), 4); // astral: 2 code units, 4 bytes
});

Deno.test("truncateBody caps by BYTES so multi-byte content can't overflow", () => {
  const big = "中".repeat(1000); // 1000 code units, 3000 bytes
  const out = truncateBody(big, 301); // 301-byte budget (forces a partial char at the boundary)
  assert(out.truncated, "should be marked truncated");
  // The kept head must respect the byte budget; the marker adds a small fixed amount.
  assert(
    byteLen(out.body) <= 301 + byteLen("…(truncated)") + 4,
    `truncated body should be ~byte-bounded, got ${byteLen(out.body)} bytes`,
  );
  // A split multi-byte char at the boundary must not leave a stray replacement marker.
  assert(!out.body.includes("�"), "must not contain a U+FFFD replacement char");
});

Deno.test("truncateBody leaves under-budget content untouched", () => {
  const small = "中".repeat(10); // 30 bytes
  const out = truncateBody(small, 16 * 1024);
  assertEquals(out.truncated, false);
  assertEquals(out.body, small);
});

Deno.test("truncateBody: old code-unit check would have overflowed, byte check does not", () => {
  // 16384 CJK chars = 16384 code units (passes a 16KiB *code-unit* gate) but
  // 49152 bytes — well over a 16KiB *byte* budget, which is the real KV limit.
  const cjk = "中".repeat(16384);
  const out = truncateBody(cjk, 16 * 1024);
  assert(out.truncated);
  assert(byteLen(out.body) <= 16 * 1024 + 32, `got ${byteLen(out.body)} bytes`);
});
