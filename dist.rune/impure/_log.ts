import { AsyncLocalStorage } from "node:async_hooks";

// Structured logging with levels + per-run correlation IDs.
//
// Levels are gated by the LOG_LEVEL env var (default "info"), so the noisy
// bootstrap/idle-cron chatter can be demoted to "debug" and stay hidden in
// production while remaining one env var away when you need the firehose.
//
// Correlation: a single check run wraps its work in withRun(runId, fn). Every
// log.* call inside that async context is prefixed with [run=<short>], so all
// the lines for one run group together even when isolates interleave.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveThreshold(): number {
  const raw = (Deno.env.get("LOG_LEVEL") ?? "info").toLowerCase().trim();
  return LEVELS[raw as LogLevel] ?? LEVELS.info;
}

// Parsed once at module load — LOG_LEVEL is a deploy-time setting.
const THRESHOLD = resolveThreshold();

interface RunStore {
  runId: string;
}

export const runContext = new AsyncLocalStorage<RunStore>();

/**
 * Run `fn` inside a correlation context so every log line it (transitively)
 * emits is tagged with the run id. Returns whatever `fn` returns.
 */
export function withRun<T>(runId: string, fn: () => T): T {
  return runContext.run({ runId }, fn);
}

function runTag(): string {
  const store = runContext.getStore();
  return store ? `[run=${store.runId.slice(0, 8)}]` : "";
}

function emit(level: LogLevel, sink: (...a: unknown[]) => void, message: unknown, args: unknown[]): void {
  if (LEVELS[level] < THRESHOLD) return;
  sink(`[${level}]${runTag()}`, message, ...args);
}

export const log = {
  debug: (message: unknown, ...args: unknown[]) => emit("debug", console.debug, message, args),
  info: (message: unknown, ...args: unknown[]) => emit("info", console.log, message, args),
  warn: (message: unknown, ...args: unknown[]) => emit("warn", console.warn, message, args),
  error: (message: unknown, ...args: unknown[]) => emit("error", console.error, message, args),
};
