/**
 * Cloudflare Worker entry (Phase 4, 2026-11-10; Batch 1 headers/health,
 * 2026-11-11).
 *
 * The default export is the TanStack Start server entry, untouched —
 * fetch handling is exactly what it was, except for two Batch 1
 * additions in the wrapper below:
 *
 * 1. Security headers on EVERY response (including /health): CSP,
 *    HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy.
 *    The wrapper re-wraps the TanStack response so headers apply to
 *    documents, RPC responses and redirects alike.
 * 2. GET /health, answered here before delegating to TanStack:
 *    { ok, time, db } with a cheap D1 SELECT 1 ping. `ok` tracks the
 *    DB ping (false when the binding is missing or the ping throws);
 *    HTTP status stays 200 and the JSON carries the verdict, so a
 *    monitor reads `ok`/`db` from the body.
 *
 * The Phase 3 Queues `queue` export is GONE (the take path moved to
 * Durable Objects; see ports-do/DESIGN.md): the take write path no
 * longer has a queue consumer, and the `queue` handler that caused
 * the 11001 saga (the Queues API reads the handler from the DEFAULT
 * export object) is deleted with it.
 *
 * `TakeSession` is re-exported here so wrangler deploys the DO class:
 * the class must be exported from the Worker's entry module for the
 * `durable_objects` migration (wrangler.jsonc) to apply.
 */
import serverEntry from "@tanstack/react-start/server-entry";

import type { CloudflareEnv } from "./server/d1";

export { TakeSession } from "./server/take-session";

/**
 * Conservative CSP (Batch 1, 2026-11-11).
 *
 * Browser-facing externals are Google Fonts ONLY (see
 * src/routes/__root.tsx: stylesheet from fonts.googleapis.com, font
 * files from fonts.gstatic.com). Everything else external (Gemini,
 * Resend, WhatsApp Graph) is fetched server-side, where CSP does
 * not apply.
 *
 * 'unsafe-inline' is required on both script-src and style-src:
 * TanStack Start hydrates through inline <script> blocks and the
 * app uses inline styles. A strict CSP would break hydration, so
 * the policy is conservative by design. Nonce-based tightening is
 * future work (it needs per-request nonce plumbing through SSR).
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handleHealth(env: CloudflareEnv | undefined): Promise<Response> {
  let db: "ok" | "error" = "error";
  try {
    if (env?.DB) {
      await env.DB.prepare("SELECT 1").first();
      db = "ok";
    }
  } catch {
    db = "error";
  }
  return new Response(
    JSON.stringify({
      ok: db === "ok",
      time: new Date().toISOString(),
      db,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

export default {
  fetch: async (...args: Parameters<typeof serverEntry.fetch>) => {
    const [request, env] = args;
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return withSecurityHeaders(await handleHealth(env as CloudflareEnv | undefined));
    }
    return withSecurityHeaders(await serverEntry.fetch(...args));
  },
};
