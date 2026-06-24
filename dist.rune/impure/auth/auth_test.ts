import { assertEquals, assertRejects } from "jsr:@std/assert";
import { createUser, deleteUser, login, validateSession } from "./auth.ts";
import { CanaryError } from "../../dto/_shared.ts";

Deno.test("createUser - rejects an empty/short password with 400 (server-side policy)", async () => {
  const err = await assertRejects(
    () => createUser(`pwtest-${crypto.randomUUID()}@example.com`, ""),
    CanaryError,
  );
  assertEquals(err.status, 400);
});

Deno.test("createUser - rejects a missing/non-string username with 400 (no raw KV TypeError)", async () => {
  const err = await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => createUser(undefined as any, "long-enough-pw"),
    CanaryError,
  );
  assertEquals(err.status, 400);
});

Deno.test("login - rejects a missing username with a CanaryError (not a raw 500)", async () => {
  await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => login(undefined as any, "x"),
    CanaryError,
  );
});

Deno.test("login - deleting a user revokes their existing session token", async () => {
  const sentinel = `revoke-sentinel-${crypto.randomUUID()}@example.com`;
  const username = `revoke-${crypto.randomUUID()}@example.com`;
  await createUser(sentinel, "correct-horse-sentinel");
  await createUser(username, "correct-horse");
  const { token } = await login(username, "correct-horse");
  // Token works before deletion.
  assertEquals((await validateSession(token)).username, username);
  await deleteUser(username);
  // After deletion the stateless token must no longer validate.
  const err = await assertRejects(() => validateSession(token), CanaryError);
  assertEquals(err.status, 401);
  await deleteUser(sentinel);
});

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
  // A second account so deleteUser's last-user lockout guard never trips when
  // cleaning up, regardless of how many users the shared test KV already holds.
  const sentinel = `authtest-sentinel-${crypto.randomUUID()}@example.com`;
  const username = `authtest-${crypto.randomUUID()}@example.com`;
  await createUser(sentinel, "correct-horse-sentinel");
  await createUser(username, "correct-horse");
  try {
    const { token } = await login(username, "correct-horse");
    const session = await validateSession(token);
    assertEquals(session.username, username);
  } finally {
    await deleteUser(username);
    await deleteUser(sentinel);
  }
});
