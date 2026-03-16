import { CanaryError } from "./dist.rune/dto/_shared.ts";
import { kv } from "./dist.rune/impure/_kv.ts";
import type { CheckDto } from "./dist.rune/dto/check-dto.ts";
import {
  createUser,
  deleteUser,
  listUsers,
  login,
  logout,
  seedAdmin,
  validateSession,
} from "./dist.rune/impure/auth/auth.ts";

// Integration imports
import { createMonitor } from "./dist.rune/integration/monitor-create/monitor-create.ts";
import { listMonitors } from "./dist.rune/integration/monitor-list/monitor-list.ts";
import { getMonitor } from "./dist.rune/integration/monitor-get/monitor-get.ts";
import { configureCheck } from "./dist.rune/integration/check-configure/check-configure.ts";
import { getCheck } from "./dist.rune/integration/check-get/check-get.ts";
import { buildSchedule } from "./dist.rune/integration/schedule-build/schedule-build.ts";
import { configureAlert } from "./dist.rune/integration/alert-configure/alert-configure.ts";
import { getAlert } from "./dist.rune/integration/alert-get/alert-get.ts";
import { setSecret } from "./dist.rune/integration/secret-set/secret-set.ts";
import { listSecrets } from "./dist.rune/integration/secret-list/secret-list.ts";
import { deleteSecret } from "./dist.rune/integration/secret-delete/secret-delete.ts";
import { executeRunner } from "./dist.rune/integration/runner-execute/runner-execute.ts";

// ---------------------------------------------------------------------------
// Seed admin on startup
// ---------------------------------------------------------------------------

const adminUsername = Deno.env.get("ADMIN_USERNAME");
const adminPassword = Deno.env.get("ADMIN_PASSWORD");
if (adminUsername && adminPassword) {
  await seedAdmin(adminUsername, adminPassword);
} else {
  console.warn("⚠️ ADMIN_USERNAME or ADMIN_PASSWORD not set — admin not seeded");
}

// ---------------------------------------------------------------------------
// Cron: check all monitors every minute, run those whose cron matches now
// ---------------------------------------------------------------------------

function matchField(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field.includes(",")) return field.split(",").some((f) => matchField(f.trim(), value));
  if (field.includes("/")) {
    const [range, step] = field.split("/");
    const s = parseInt(step);
    if (range === "*") return value % s === 0;
    const [start, end] = range.split("-").map(Number);
    return value >= start && value <= end && (value - start) % s === 0;
  }
  if (field.includes("-")) {
    const [start, end] = field.split("-").map(Number);
    return value >= start && value <= end;
  }
  return parseInt(field) === value;
}

function cronMatchesNow(cron: string, now: Date): boolean {
  const [min, hour, day, month, weekday] = cron.trim().split(/\s+/);
  return (
    matchField(min, now.getMinutes()) &&
    matchField(hour, now.getHours()) &&
    matchField(day, now.getDate()) &&
    matchField(month, now.getMonth() + 1) &&
    matchField(weekday, now.getDay())
  );
}

const startedAt = new Date().toISOString();
let lastCronTick: string | null = null;

Deno.cron("canary-runner", "* * * * *", async () => {
  const now = new Date();
  lastCronTick = now.toISOString();
  console.log("🔍 cron tick:", now.toISOString());

  for await (const entry of kv.list<CheckDto>({ prefix: ["check"] })) {
    const checkDto = entry.value;
    if (cronMatchesNow(checkDto.cron, now)) {
      console.log("⏰ scheduling run for monitor:", checkDto.monitorId);
      executeRunner({ monitorId: checkDto.monitorId }).catch((e) => {
        console.error("❌ runner failed for", checkDto.monitorId, ":", (e as Error).message);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(e: unknown): Response {
  if (e instanceof CanaryError) {
    return json({ error: e.fault, message: e.message }, e.status);
  }
  const msg = e instanceof Error ? e.message : String(e);
  console.error("❌ unhandled error:", msg);
  return json({ error: "internal-error", message: msg }, 500);
}

async function parseBody<T>(req: Request): Promise<T> {
  try {
    return await req.json() as T;
  } catch {
    throw new CanaryError("validation-error", "Request body must be valid JSON", 400);
  }
}

function extractToken(req: Request): string {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new CanaryError("unauthorized", "Missing Authorization header", 401);
  return token;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  try {
    // GET / — public health check
    if (method === "GET" && pathname === "/") {
      const monitors = await listMonitors();
      return json({
        status: "ok",
        startedAt,
        lastCronTick,
        monitors: monitors.monitors.length,
      });
    }

    // POST /auth/login — public
    if (method === "POST" && pathname === "/auth/login") {
      const body = await parseBody<{ username: string; password: string }>(req);
      return json(await login(body.username, body.password));
    }

    // All routes below require a valid session
    const token = extractToken(req);
    await validateSession(token);

    // POST /auth/logout
    if (method === "POST" && pathname === "/auth/logout") {
      await logout(token);
      return json({ ok: true });
    }

    // POST /users
    if (method === "POST" && pathname === "/users") {
      const body = await parseBody<{ username: string; password: string }>(req);
      await createUser(body.username, body.password);
      return json({ ok: true }, 201);
    }

    // GET /users
    if (method === "GET" && pathname === "/users") {
      return json(await listUsers());
    }

    // DELETE /users/:username
    const userMatch = pathname.match(/^\/users\/([^/]+)$/);
    if (userMatch && method === "DELETE") {
      await deleteUser(decodeURIComponent(userMatch[1]));
      return json({ ok: true });
    }

    // POST /monitors
    if (method === "POST" && pathname === "/monitors") {
      const body = await parseBody(req);
      const result = await createMonitor(body as Parameters<typeof createMonitor>[0]);
      return json(result, 201);
    }

    // GET /monitors
    if (method === "GET" && pathname === "/monitors") {
      return json(await listMonitors());
    }

    // /monitors/:id
    const monitorMatch = pathname.match(/^\/monitors\/([^/]+)$/);
    if (monitorMatch) {
      const monitorId = monitorMatch[1];
      if (method === "GET") return json(await getMonitor({ monitorId }));
    }

    // /monitors/:id/check
    const checkMatch = pathname.match(/^\/monitors\/([^/]+)\/check$/);
    if (checkMatch) {
      const monitorId = checkMatch[1];
      if (method === "POST") {
        const body = await parseBody(req);
        return json(await configureCheck({ ...(body as object), monitorId } as Parameters<typeof configureCheck>[0]));
      }
      if (method === "GET") return json(await getCheck({ monitorId }));
    }

    // /monitors/:id/alert
    const alertMatch = pathname.match(/^\/monitors\/([^/]+)\/alert$/);
    if (alertMatch) {
      const monitorId = alertMatch[1];
      if (method === "POST") {
        const body = await parseBody(req);
        return json(await configureAlert({ ...(body as object), monitorId } as Parameters<typeof configureAlert>[0]));
      }
      if (method === "GET") return json(await getAlert({ monitorId }));
    }

    // POST /schedule/build
    if (method === "POST" && pathname === "/schedule/build") {
      const body = await parseBody(req);
      return json(buildSchedule(body as Parameters<typeof buildSchedule>[0]));
    }

    // POST /secrets
    if (method === "POST" && pathname === "/secrets") {
      const body = await parseBody(req);
      return json(await setSecret(body as Parameters<typeof setSecret>[0]));
    }

    // GET /secrets
    if (method === "GET" && pathname === "/secrets") {
      return json(await listSecrets());
    }

    // DELETE /secrets/:key
    const secretMatch = pathname.match(/^\/secrets\/([^/]+)$/);
    if (secretMatch && method === "DELETE") {
      return json(await deleteSecret({ secretKey: decodeURIComponent(secretMatch[1]) }));
    }

    // POST /run/:monitorId  (manual trigger)
    const runMatch = pathname.match(/^\/run\/([^/]+)$/);
    if (runMatch && method === "POST") {
      return json(await executeRunner({ monitorId: runMatch[1] }));
    }

    return json({ error: "not-found", message: `No route for ${method} ${pathname}` }, 404);
  } catch (e) {
    return errorResponse(e);
  }
});

console.log("🚀 Canary is running");
