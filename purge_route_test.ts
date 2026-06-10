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
  const username = `purgeroute-${crypto.randomUUID()}@example.com`;
  await createUser(username, "correct-horse");
  try {
    const { token } = await login(username, "correct-horse");
    await fn(token);
  } finally {
    await deleteUser(username);
  }
}

Deno.test({
  name: "DELETE /api/runs - returns 500 + purge-failed when the purge cannot delete",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    withSession(async (token) => {
      const realPurge = RunResult.purge;
      (RunResult as { purge: unknown }).purge = () => Promise.resolve(false);
      try {
        const res = await fetch(`${BASE}/api/runs/mon-x/${TS}/run-x`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
        assertEquals(res.status, 500);
        assertEquals((await res.json()).error, "purge-failed");
      } finally {
        (RunResult as { purge: unknown }).purge = realPurge;
      }
    }),
});

Deno.test({
  name: "DELETE /api/runs - returns 200 {ok:true} on a successful purge",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    withSession(async (token) => {
      const realPurge = RunResult.purge;
      (RunResult as { purge: unknown }).purge = () => Promise.resolve(true);
      try {
        const res = await fetch(`${BASE}/api/runs/mon-x/${TS}/run-x`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
        assertEquals(res.status, 200);
        assertEquals((await res.json()).ok, true);
      } finally {
        (RunResult as { purge: unknown }).purge = realPurge;
      }
    }),
});
