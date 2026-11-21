import type { D1Database } from "./d1-auth-store";
import type { R2BucketLike } from "./d1";
import { buildR2Key, r2Put } from "./d1-r2";
import { decodeDataUrl, HandwrittenError, isTeacherCaller, type Caller } from "./d1-handwritten";
import type { PaperReferenceKind } from "./paper-reading-prompt";

export type PaperReference = {
  id: string;
  title: string;
  kind: PaperReferenceKind;
  image_path: string;
  confirmed_text: string;
  created_at: string;
};
function teacher(caller: Caller) {
  if (!isTeacherCaller(caller)) throw new HandwrittenError("FORBIDDEN");
}
/** Immutable: a changed model answer is a new reference, never a silent edit. */
export async function confirmPaperReference(
  db: D1Database,
  caller: Caller,
  bucket: R2BucketLike,
  input: { title: string; kind: PaperReferenceKind; dataUrl: string; confirmedText: string },
): Promise<PaperReference> {
  teacher(caller);
  if (
    !input.title.trim() ||
    input.title.length > 200 ||
    !input.confirmedText.trim() ||
    input.confirmedText.length > 8000 ||
    (input.kind !== "written" && input.kind !== "bubble") ||
    input.dataUrl.length > 4_000_000
  )
    throw new HandwrittenError("INVALID_INPUT");
  const { bytes, mime } = decodeDataUrl(input.dataUrl);
  const id = crypto.randomUUID();
  const image_path = buildR2Key(caller.id, id, `reference.${mime.split("/")[1]}`);
  await r2Put(bucket, caller.id, image_path, bytes);
  const reference: PaperReference = {
    id,
    title: input.title.trim(),
    kind: input.kind,
    image_path,
    confirmed_text: input.confirmedText.trim(),
    created_at: new Date().toISOString(),
  };
  try {
    await db
      .prepare(
        "INSERT INTO handwritten_references (id, teacher_id, title, kind, image_path, confirmed_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        caller.id,
        reference.title,
        reference.kind,
        image_path,
        reference.confirmed_text,
        reference.created_at,
      )
      .run();
  } catch (error) {
    await bucket.delete(image_path).catch(() => undefined);
    throw error;
  }
  return reference;
}
export async function listPaperReferences(
  db: D1Database,
  caller: Caller,
): Promise<PaperReference[]> {
  teacher(caller);
  const { results } = await db
    .prepare(
      "SELECT id, title, kind, image_path, confirmed_text, created_at FROM handwritten_references WHERE teacher_id = ? ORDER BY created_at DESC LIMIT 100",
    )
    .bind(caller.id)
    .all<PaperReference>();
  return results ?? [];
}
export async function getPaperReference(
  db: D1Database,
  caller: Caller,
  id: string,
): Promise<PaperReference> {
  teacher(caller);
  const row = await db
    .prepare(
      "SELECT id, title, kind, image_path, confirmed_text, created_at FROM handwritten_references WHERE id = ? AND teacher_id = ?",
    )
    .bind(id, caller.id)
    .first<PaperReference>();
  if (!row) throw new HandwrittenError("NOT_FOUND");
  return row;
}
