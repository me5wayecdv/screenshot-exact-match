/**
 * D1 + R2 binding access for TanStack Start server functions (Phase 2).
 *
 * Wiring (resolved in Phase 2, corrected for staging 2026-11-04):
 * - Tests and smoke scripts inject a binding with setD1Binding() /
 *   setR2Bindings(). Production code must never call those functions.
 * - In production the code runs inside a Cloudflare Worker, where the
 *   runtime provides bindings through the `cloudflare:workers` module
 *   (`env.DB`, `env.PAPERS_BUCKET`, `env.SOURCES_BUCKET`). That module
 *   MUST be imported statically (see loadWorkerEnv): the previous
 *   `new Function("return import(...)")` trick never ran in a Worker —
 *   workerd forbids code generation from strings, so the constructor
 *   threw "Code generation from strings disallowed for this context",
 *   the catch swallowed it into null, and every server function
 *   failed with D1_NOT_WIRED even though the bindings were deployed.
 *   Any failure still becomes the typed D1_NOT_WIRED error — never a
 *   Supabase fallback, never an empty database. A silent fallback
 *   here would be a data-integrity bug, not a convenience.
 * - Under vitest the `cloudflare:workers` import is aliased to
 *   src/test/cloudflare-workers-stub.ts (empty env), so tests keep
 *   the loud NOT_WIRED failure unless they inject a binding.
 * - wrangler.jsonc must declare the bindings (d1_databases + r2_buckets)
 *   with exactly these names, or production lookup fails loudly.
 *
 * Security boundary: the browser NEVER touches D1 or R2. Bindings are
 * only reachable from Worker code, and every server function must
 * resolve the session first and check ownership/membership in code
 * before querying (D1 has no RLS).
 */

import type { D1Database } from "@/server/d1-auth-store";
// Static import on purpose (see header): workerd forbids `new Function`
// code generation, so a runtime-only dynamic import of this module can
// never succeed inside a Worker. The @cloudflare/vite-plugin build leaves
// this import external to the workerd runtime module; under vitest it is
// aliased to src/test/cloudflare-workers-stub.ts.
import { env as workerEnv } from "cloudflare:workers";

export type R2BucketLike = {
  put(key: string, value: unknown, options?: unknown): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size: number } | null>;
  delete(key: string): Promise<void>;
  head?(key: string): Promise<{ size: number } | null>;
};

/** MailChannels `send_email` binding shape (wrangler.jsonc). The real
 *  binding's send() takes a Worker EmailMessage; d1-email.ts adapts a
 *  plain message to it, so this type stays testable without a Worker. */
export type SendEmailBindingLike = {
  send(message: unknown): Promise<unknown>;
};

/** Cloudflare Queues producer binding shape (wrangler.jsonc, Phase 3).
 *  `send()` resolves only after the queue durably accepts the message,
 *  so a resolved send is a durability guarantee, not fire-and-forget.
 *  The optional second argument is the Queues send options
 *  (`delaySeconds`, `contentType`); producers here use the defaults. */
export type TakeQueueBindingLike = {
  send(message: unknown, options?: { delaySeconds?: number }): Promise<void>;
};

export type CloudflareEnv = {
  DB?: D1Database;
  PAPERS_BUCKET?: R2BucketLike;
  SOURCES_BUCKET?: R2BucketLike;
  SEB?: SendEmailBindingLike;
  TAKE_QUEUE?: TakeQueueBindingLike;
  [key: string]: unknown;
};

let injectedDb: D1Database | null = null;
let injectedQueue: TakeQueueBindingLike | null = null;
let injectedR2: { papers: R2BucketLike | null; sources: R2BucketLike | null } = {
  papers: null,
  sources: null,
};

/** Test/smoke-script injection only. Never call from production code. */
export function setD1Binding(db: D1Database | null): void {
  injectedDb = db;
}

/** Test/smoke-script injection only. Never call from production code. */
export function setR2Bindings(buckets: {
  papers?: R2BucketLike | null;
  sources?: R2BucketLike | null;
}): void {
  injectedR2 = { papers: buckets.papers ?? null, sources: buckets.sources ?? null };
}

/** Test injection for the take-writes Queue binding only. Never call
 *  from production code. */
export function setTakeQueueBinding(queue: TakeQueueBindingLike | null): void {
  injectedQueue = queue;
}

async function loadWorkerEnv(): Promise<CloudflareEnv | null> {
  // The statically imported `env` is the Worker's own bindings object
  // (Cloudflare's importable-env: available from anywhere in Worker
  // code, including lazily loaded server-function chunks). It is kept
  // async so callers' signatures are unchanged. A null/empty env
  // still falls through to the typed NOT_WIRED error in the callers.
  return (workerEnv ?? null) as unknown as CloudflareEnv | null;
}

function notWired(what: string): Error {
  return new Error(
    `${what}_NOT_WIRED: no Cloudflare binding is available to this server function. ` +
      `Check wrangler.jsonc bindings and that this code runs inside a Worker (see src/server/d1.ts).`,
  );
}

/** Synchronous accessor for code paths that already injected a binding (tests). */
export function getD1(): D1Database {
  if (injectedDb) return injectedDb;
  throw notWired("D1");
}

/** Raw Worker env for callers that need non-D1/R2 bindings (e.g. the
 *  MailChannels send_email binding). Returns null outside a Worker. */
export async function getWorkerEnv(): Promise<CloudflareEnv | null> {
  return loadWorkerEnv();
}

/** Async accessor for server functions: injected binding first, then Worker env. */
export async function getD1Async(): Promise<D1Database> {
  if (injectedDb) return injectedDb;
  const env = await loadWorkerEnv();
  if (env?.DB) return env.DB;
  throw notWired("D1");
}

export async function getPapersBucket(): Promise<R2BucketLike> {
  if (injectedR2.papers) return injectedR2.papers;
  const env = await loadWorkerEnv();
  if (env?.PAPERS_BUCKET) return env.PAPERS_BUCKET;
  throw notWired("R2_PAPERS");
}

export async function getSourcesBucket(): Promise<R2BucketLike> {
  if (injectedR2.sources) return injectedR2.sources;
  const env = await loadWorkerEnv();
  if (env?.SOURCES_BUCKET) return env.SOURCES_BUCKET;
  throw notWired("R2_SOURCES");
}

/** Async accessor for the take-writes Queue producer binding (Phase 3):
 *  injected binding first (tests), then Worker env. Throws the typed
 *  TAKE_QUEUE_NOT_WIRED error when the binding is missing — a producer
 *  must never silently fall back to a direct D1 write, or the burst
 *  protection it exists for would silently vanish. */
export async function getTakeQueue(): Promise<TakeQueueBindingLike> {
  if (injectedQueue) return injectedQueue;
  const env = await loadWorkerEnv();
  if (env?.TAKE_QUEUE) return env.TAKE_QUEUE;
  throw notWired("TAKE_QUEUE");
}
