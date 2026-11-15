import {
  saveHandwrittenGrade as processGrade,
  type SaveHandwrittenGradeInput,
  type Caller,
} from "@/server/d1-handwritten";
import type { D1Database } from "@/server/d1-auth-store";
/** Existing persistence cases exercise the real preview then save contract. */
export async function saveHandwrittenGrade(
  db: D1Database,
  caller: Caller,
  input: SaveHandwrittenGradeInput,
) {
  process.env["GRADE_PREVIEW_SIGNING_KEY"] = "synthetic-test-key-only-000000000000000000000000";
  const preview = await processGrade(db, caller, input, { preview: true });
  return processGrade(db, caller, { ...input, previewId: preview.id });
}
