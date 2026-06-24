import { assertEquals } from "jsr:@std/assert";
import { createUser, deleteUser, login } from "./dist.rune/impure/auth/auth.ts";
import { RunResult } from "./dist.rune/impure/runResult/runResult.ts";
// Importing main.ts boots the real request handler (Deno.serve on :8000) and
// registers the canary cron — both live for the whole test process, so the route
// tests below disable the resource/op sanitizers. This is the only file that imports
// main.ts, so the server binds exactly once.
import "./main.ts";

const BASE = "http://localhost:8000";
const TS = encodeURIComponent("2026-01-01T00:00:00.000Z");

// Mint a real session token the same way auth_test.ts does — the DELETE /api/runs
// route sits below main.ts's `validateSession` gate, so an unauthenticated request
// would 401 before ever reaching the purge logic we want to exercise.
async function withSession(fn: (token: string) => Promise<void>) {
  // A sentinel account so deleteUser's last-user lockout guard never trips on
  // cleanup, no matter how many users the shared test KV already holds.
  const sentinel = `purgeroute-sentinel-${crypto.randomUUID()}@example.com`;
  const username = `purgeroute-${crypto.randomUUID()}@example.com`;
  await createUser(sentinel, "correct-horse-sentinel");
  await createUser(username, "correct-horse");
  try {
    const { token } = await login(username, "correct-horse");
    await fn(token);
  } finally {
    await deleteUser(username);
    await deleteUser(sentinel);
  }
}

// Stub RunResult.purge to a fixed result for one session, always restoring it in a
// finally. Centralizing the save/restore here means a future route test can't copy
// the pattern and forget the cleanup, leaking a stubbed purge into the shared process.
function withStubbedPurge(value: boolean, fn: (token: string) => Promise<void>) {
  return withSession(async (token) => {
    const realPurge = RunResult.purge;
    (RunResult as { purge: unknown }).purge = () => Promise.resolve(value);
    try {
      await fn(token);
    } finally {
      (RunResult as { purge: unknown }).purge = realPurge;
    }
  });
}

// One DELETE /api/runs case: stub the purge result, fire the request, assert the
// status + body. The URL, method, auth header, and sanitizer flags — which must stay
// in lockstep across cases — are written once here.
function purgeRouteCase(
  name: string,
  purgeReturn: boolean,
  expectedStatus: number,
  assertBody: (body: Record<string, unknown>) => void,
) {
  Deno.test({
    name,
    sanitizeResources: false, // main.ts's server + cron live for the whole process
    sanitizeOps: false,
    fn: () =>
      withStubbedPurge(purgeReturn, async (token) => {
        const res = await fetch(`${BASE}/api/runs/mon-x/${TS}/run-x`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
        assertEquals(res.status, expectedStatus);
        assertBody(await res.json());
      }),
  });
}

purgeRouteCase(
  "DELETE /api/runs - returns 500 + purge-failed when the purge cannot delete",
  false,
  500,
  (b) => assertEquals(b.error, "purge-failed"),
);

purgeRouteCase(
  "DELETE /api/runs - returns 200 {ok:true} on a successful purge",
  true,
  200,
  (b) => assertEquals(b.ok, true),
);
