/**
 * Tiny structured logger (Batch 1, 2026-11-11).
 *
 * One JSON line per event to the console — Cloudflare's observability
 * pipeline picks console output up as logs. No vendor SDK, no network
 * calls, no PII: call sites pass only what they explicitly include.
 * Keep the shape stable: { ts, level, msg, ...context }.
 */

export type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, msg: string, context?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...context,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
