import { assertEquals, assertRejects } from "jsr:@std/assert";
import { createUser, deleteUser, login, validateSession } from "./auth.ts";
import { CanaryError } from "../../dto/_shared.ts";

// validateSession is the single gate every authenticated route inherits (the
// `// All routes below require auth` block in main.ts calls it before any handler
// runs). These tests pin that it rejects missing/invalid tokens with a 401 and
// accepts a freshly minted one — so the new DELETE /api/runs and dismiss-corrupt
// routes, which sit below that gate, are covered structurally.

Deno.test("validateSession - rejects a missing/empty token with 401", async () => {
  const err = await assertRejects(() => validateSession(""), CanaryError);
  assertEquals(err.status, 401);
});

Deno.test("validateSession - rejects a malformed token (no signature) with 401", async () => {
  const err = await assertRejects(() => validateSession("not-a-real-token"), CanaryError);
  assertEquals(err.status, 401);
});

Deno.test("validateSession - rejects a tampered token (bad signature) with 401", async () => {
  const err = await assertRejects(() => validateSession("payload.deadbeef"), CanaryError);
  assertEquals(err.status, 401);
});

Deno.test("validateSession - accepts a freshly minted token and returns the username", async () => {
  const username = `authtest-${crypto.randomUUID()}@example.com`;
  await createUser(username, "correct-horse");
  try {
    const { token } = await login(username, "correct-horse");
    const session = await validateSession(token);
    assertEquals(session.username, username);
  } finally {
    await deleteUser(username);
  }
});
