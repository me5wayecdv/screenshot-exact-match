/**
 * Minimal structural types for Cloudflare Durable Objects (Phase 4).
 *
 * The repo keeps server code free of @cloudflare dependencies (cf.
 * take-queue.ts's structural batch types), so the DO surface used
 * here is declared locally instead of importing
 * @cloudflare/workers-types. Only the surface this codebase touches
 * is declared — if the DO uses a new runtime API, declare it here
 * first. At runtime these are Worker globals; in vitest (node) the
 * `DurableObject` global does not exist, so modules that extend it
 * (take-session.ts) are never imported by tests — only the pure
 * logic module (take-session-logic.ts) is.
 */

/** Durable Object SQLite storage (subset used by TakeSession). */
export type SqlStorageCursorLike<T> = {
  toArray(): T[];
};

export type SqlStorageLike = {
  exec<T>(sql: string, ...params: unknown[]): SqlStorageCursorLike<T>;
};

/** Durable Object storage (subset used by TakeSession). */
export type DurableObjectStorageLike = {
  sql: SqlStorageLike;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
};

/** Durable Object state (subset used by TakeSession). */
export type DurableObjectStateLike = {
  storage: DurableObjectStorageLike;
  id: { toString(): string };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
};

/** The instance side of the DurableObject base class. */
export type DurableObjectLike = {
  fetch(request: Request): Promise<Response>;
  alarm?(): Promise<void>;
};

/** The DurableObject base class is a Worker runtime global (not an
 *  import). It is declared here so its constructor shape is typed;
 *  the value is resolved lazily from globalThis in take-session.ts
 *  (a bare `extends DurableObject` fails Cloudflare's deploy-time
 *  validation, where the global is not yet defined). At runtime the
 *  Worker provides the global; in vitest (node) it does not exist,
 *  so modules that define the DO class are never imported by tests —
 *  only the pure logic module (take-session-logic.ts) is. */
declare global {
  const DurableObject: new (
    state: DurableObjectStateLike,
    env: unknown,
  ) => DurableObjectLike;
}
