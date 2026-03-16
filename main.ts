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
// Static assets
// ---------------------------------------------------------------------------

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <ellipse cx="42" cy="64" rx="26" ry="20" fill="#FFD700"/>
  <circle cx="66" cy="38" r="19" fill="#FFD700"/>
  <polygon points="83,36 97,32 83,43" fill="#FF8C00"/>
  <circle cx="72" cy="32" r="4.5" fill="#1a1a1a"/>
  <circle cx="73" cy="31" r="1.8" fill="white"/>
  <ellipse cx="37" cy="65" rx="17" ry="9" fill="#FFC107" transform="rotate(-15 37 65)"/>
  <polygon points="17,70 4,58 4,80" fill="#FFB300"/>
  <line x1="46" y1="84" x2="38" y2="96" stroke="#FF8C00" stroke-width="3.5" stroke-linecap="round"/>
  <line x1="38" y1="96" x2="32" y2="99" stroke="#FF8C00" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="38" y1="96" x2="43" y2="100" stroke="#FF8C00" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="56" y1="84" x2="64" y2="96" stroke="#FF8C00" stroke-width="3.5" stroke-linecap="round"/>
  <line x1="64" y1="96" x2="70" y2="99" stroke="#FF8C00" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="64" y1="96" x2="60" y2="100" stroke="#FF8C00" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Canary</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --yellow: #FFD700;
      --bg: #0f0f0f;
      --surface: #1a1a1a;
      --border: #2a2a2a;
      --text: #e0e0e0;
      --muted: #777;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .page { width: 100%; max-width: 480px; padding: 24px; }

    /* Login */
    .login-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 44px 40px;
    }
    .logo { text-align: center; margin-bottom: 36px; }
    .logo img { width: 60px; height: 60px; }
    .logo h1 { font-size: 22px; font-weight: 600; margin-top: 14px; letter-spacing: 0.3px; }
    .logo p { color: var(--muted); font-size: 13px; margin-top: 5px; }
    .form-group { margin-bottom: 14px; }
    label { display: block; font-size: 12px; font-weight: 500; margin-bottom: 7px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px; }
    input {
      width: 100%; padding: 11px 14px;
      background: var(--bg); border: 1px solid var(--border);
      border-radius: 8px; color: var(--text); font-size: 14px;
      outline: none; transition: border-color 0.15s;
    }
    input:focus { border-color: var(--yellow); }
    .btn {
      width: 100%; padding: 12px;
      background: var(--yellow); color: #000;
      border: none; border-radius: 8px;
      font-size: 14px; font-weight: 600;
      cursor: pointer; margin-top: 10px;
      transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.88; }
    .btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .error { color: #ff5f5f; font-size: 13px; margin-top: 14px; text-align: center; min-height: 18px; }

    /* Dashboard */
    #dashboard { display: none; }
    .dash-header {
      display: flex; align-items: center;
      justify-content: space-between; margin-bottom: 28px;
    }
    .dash-title { display: flex; align-items: center; gap: 12px; }
    .dash-title img { width: 30px; height: 30px; }
    .dash-title h1 { font-size: 18px; font-weight: 600; }
    .logout-btn {
      background: none; border: 1px solid var(--border);
      color: var(--muted); border-radius: 8px;
      padding: 6px 14px; font-size: 12px;
      cursor: pointer; transition: border-color 0.15s, color 0.15s;
    }
    .logout-btn:hover { border-color: var(--text); color: var(--text); }
    .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; padding: 20px;
    }
    .full { grid-column: 1 / -1; }
    .card-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .card-value { font-size: 30px; font-weight: 700; margin-top: 8px; }
    .card-value.ok { color: var(--yellow); }
    .card-sub { font-size: 13px; font-weight: 500; margin-top: 8px; color: var(--text); }
    .card-sub.dim { color: var(--muted); }
    .api-hint {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; padding: 16px 20px;
      font-size: 12px; color: var(--muted); line-height: 1.7;
    }
    .api-hint code {
      background: var(--bg); padding: 1px 6px; border-radius: 4px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 11px; color: var(--yellow);
    }
  </style>
</head>
<body>
<div class="page">

  <div id="login">
    <div class="login-card">
      <div class="logo">
        <img src="/favicon.svg" alt="Canary">
        <h1>Canary</h1>
        <p>HTTP monitoring and alerting</p>
      </div>
      <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" placeholder="you@example.com" autocomplete="username">
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;" autocomplete="current-password">
      </div>
      <button class="btn" id="login-btn" onclick="doLogin()">Sign in</button>
      <div class="error" id="login-error"></div>
    </div>
  </div>

  <div id="dashboard">
    <div class="dash-header">
      <div class="dash-title">
        <img src="/favicon.svg" alt="Canary">
        <h1>Canary</h1>
      </div>
      <button class="logout-btn" onclick="doLogout()">Sign out</button>
    </div>
    <div class="cards">
      <div class="card">
        <div class="card-label">Status</div>
        <div class="card-value ok" id="status-val">ok</div>
      </div>
      <div class="card">
        <div class="card-label">Monitors</div>
        <div class="card-value" id="monitors-val">—</div>
      </div>
      <div class="card full">
        <div class="card-label">Last cron tick</div>
        <div class="card-sub dim" id="tick-val">—</div>
      </div>
      <div class="card full">
        <div class="card-label">Started</div>
        <div class="card-sub dim" id="started-val">—</div>
      </div>
    </div>
    <div class="api-hint">
      Use <code>Authorization: Bearer &lt;token&gt;</code> to access the API programmatically.
      Your session is stored in this browser and expires after 24 hours.
    </div>
  </div>

</div>
<script>
  const TOKEN_KEY = 'canary_token';
  const getToken = () => localStorage.getItem(TOKEN_KEY);
  const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
  const clearToken = () => localStorage.removeItem(TOKEN_KEY);

  async function doLogin() {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const btn = document.getElementById('login-btn');
    const err = document.getElementById('login-error');
    if (!username || !password) { err.textContent = 'Username and password are required.'; return; }
    btn.disabled = true; btn.textContent = 'Signing in...'; err.textContent = '';
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) { err.textContent = data.message || 'Login failed.'; return; }
      setToken(data.token);
      showDashboard();
    } catch { err.textContent = 'Network error. Please try again.'; }
    finally { btn.disabled = false; btn.textContent = 'Sign in'; }
  }

  async function doLogout() {
    const token = getToken();
    if (token) fetch('/auth/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } }).catch(() => {});
    clearToken();
    showLogin();
  }

  async function showDashboard() {
    document.getElementById('login').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    try {
      const res = await fetch('/api/status');
      const d = await res.json();
      document.getElementById('monitors-val').textContent = d.monitors ?? '—';
      document.getElementById('status-val').textContent = d.status || 'ok';
      document.getElementById('tick-val').textContent = d.lastCronTick
        ? new Date(d.lastCronTick).toLocaleString() : 'Not yet ticked';
      document.getElementById('started-val').textContent = d.startedAt
        ? new Date(d.startedAt).toLocaleString() : '—';
    } catch {}
  }

  function showLogin() {
    document.getElementById('login').style.display = 'block';
    document.getElementById('dashboard').style.display = 'none';
  }

  document.getElementById('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('username').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('password').focus(); });

  if (getToken()) showDashboard();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function html(content: string): Response {
  return new Response(content, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
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
    // GET / — login/dashboard UI
    if (method === "GET" && pathname === "/") {
      return html(INDEX_HTML);
    }

    // GET /favicon.svg
    if (method === "GET" && pathname === "/favicon.svg") {
      return new Response(FAVICON_SVG, {
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
      });
    }

    // GET /api/status — public JSON status
    if (method === "GET" && pathname === "/api/status") {
      const monitors = await listMonitors();
      return json({ status: "ok", startedAt, lastCronTick, monitors: monitors.monitors.length });
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
