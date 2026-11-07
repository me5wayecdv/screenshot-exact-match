/**
 * R2 mediation (Phase 2). The browser NEVER talks to R2 directly:
 * every upload/download goes through a Worker server function that
 * checks the session and ownership first, then streams via the
 * binding. Buckets are private; no public URLs are handed out.
 *
 * Key shape (enforced, not advisory): {teacher_id}/{uuid}/{name}
 * - Exactly 3 segments. The first segment MUST equal the session
 *   teacher's id — a client-supplied teacher id is never trusted.
 * - The middle segment must be a UUID (the per-upload folder).
 * - The name segment must be non-empty, contain no '/' or '\\',
 *   and must not be '.' or '..'. Any violation throws; it is never
 *   silently "cleaned", because cleaning changes which file is
 *   addressed and can mask a traversal attempt.
 * - Downloads are streamed through the Worker (session-checked),
 *   not via a signed URL: R2 presigned URLs would need S3-compatible
 *   signing, and a long-lived URL would outlive the session check.
 *   If a short-lived download link is ever wanted, it must be a
 *   Worker endpoint that re-checks the session and expires the
 *   token server-side — not an R2 URL.
 */

import { getPapersBucket, getSourcesBucket, type R2BucketLike } from "@/server/d1";

export const PAPERS_BUCKET_NAME = "qemmini-handwritten-papers";
export const SOURCES_BUCKET_NAME = "qemmini-generation-sources";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class R2Error extends Error {
  constructor(
    public readonly code: "INVALID_KEY" | "FORBIDDEN" | "NOT_FOUND",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "R2Error";
  }
}

/** Validates a key against the caller's teacher id. Returns the key unchanged. */
export function validateR2Key(teacherId: string, key: string): string {
  if (!teacherId) throw new R2Error("FORBIDDEN");
  const parts = key.split("/");
  if (parts.length !== 3) throw new R2Error("INVALID_KEY");
  const [owner, folder, name] = parts;
  if (owner !== teacherId) throw new R2Error("FORBIDDEN");
  if (!folder || !UUID_RE.test(folder)) throw new R2Error("INVALID_KEY");
  if (!name || name === "." || name === ".." || name.includes("\\")) {
    throw new R2Error("INVALID_KEY");
  }
  return key;
}

export function buildR2Key(teacherId: string, folderUuid: string, fileName: string): string {
  const safeName = fileName.replace(/[\\/]/g, "_");
  return validateR2Key(teacherId, `${teacherId}/${folderUuid}/${safeName}`);
}

export async function r2Put(
  bucket: R2BucketLike,
  teacherId: string,
  key: string,
  body: ArrayBuffer | Uint8Array,
): Promise<void> {
  validateR2Key(teacherId, key);
  await bucket.put(key, body);
}

export async function r2Get(
  bucket: R2BucketLike,
  teacherId: string,
  key: string,
): Promise<ArrayBuffer | null> {
  validateR2Key(teacherId, key);
  const obj = await bucket.get(key);
  if (!obj) return null;
  return obj.arrayBuffer();
}

export async function r2Delete(
  bucket: R2BucketLike,
  teacherId: string,
  key: string,
): Promise<void> {
  validateR2Key(teacherId, key);
  await bucket.delete(key);
}

export async function papersBucket(): Promise<R2BucketLike> {
  return getPapersBucket();
}

export async function sourcesBucket(): Promise<R2BucketLike> {
  return getSourcesBucket();
}
