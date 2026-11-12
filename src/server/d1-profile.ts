/**
 * D1 profile (Phase 2 port of /profile's own-data reads/writes).
 *
 * NOTE ON PLACEMENT: the batch's enumerated server files had no home
 * for profile data, so this is a new file (no existing file touched).
 * Every function here touches ONLY the caller's own row:
 * - getMyProfileExtra: profiles.created_at for the caller, plus
 *   teacher_profiles.subjects_text for teachers. The subject field
 *   is stored here and nowhere else — it is deliberately NOT read
 *   by any assistant prompt builder.
 * - updateMyFullName: UPDATE profiles SET full_name WHERE id =
 *   caller. No other row can be updated through this function.
 * - updateMySubject: teacher-only upsert of the caller's own
 *   teacher_profiles row. ON CONFLICT updates subjects_text and
 *   type only, preserving bio — mirroring the old upsert, which
 *   passed only user_id/type/subjects_text.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";

export type Caller = { id: string; role: string };

export function normalizeRole(role: string): string {
  return role === "teacher" ? "school_teacher" : role;
}

export class ProfileError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "INVALID_INPUT",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ProfileError";
  }
}

export type MyProfileExtra = {
  createdAt: string | null;
  subjectsText: string | null;
};

export async function getMyProfileExtra(db: D1Database, caller: Caller): Promise<MyProfileExtra> {
  const [profile, subject] = await Promise.all([
    db
      .prepare("SELECT created_at FROM profiles WHERE id = ?")
      .bind(caller.id)
      .first<{ created_at: string | null }>(),
    db
      .prepare("SELECT subjects_text FROM teacher_profiles WHERE user_id = ?")
      .bind(caller.id)
      .first<{ subjects_text: string | null }>(),
  ]);
  return {
    createdAt: profile?.created_at ?? null,
    subjectsText: subject?.subjects_text ?? null,
  };
}

export async function updateMyFullName(
  db: D1Database,
  caller: Caller,
  fullName: string,
): Promise<void> {
  const trimmed = fullName.trim();
  if (!trimmed || trimmed.length > 100) {
    throw new ProfileError("INVALID_INPUT");
  }
  await db.prepare("UPDATE profiles SET full_name = ? WHERE id = ?").bind(trimmed, caller.id).run();
}

export async function updateMySubject(
  db: D1Database,
  caller: Caller,
  subjectsText: string,
): Promise<void> {
  const role = normalizeRole(caller.role);
  if (role !== "school_teacher" && role !== "tutor") {
    throw new ProfileError("FORBIDDEN");
  }
  const trimmed = subjectsText.trim().slice(0, 100);
  await db
    .prepare(
      "INSERT INTO teacher_profiles (user_id, bio, subjects_text, type) VALUES (?, '', ?, ?) " +
        "ON CONFLICT(user_id) DO UPDATE SET subjects_text = excluded.subjects_text, type = excluded.type",
    )
    .bind(caller.id, trimmed, role)
    .run();
}

function ctxSession(context: unknown): AuthSession {
  return (context as { session: AuthSession }).session;
}

function ctxDb(context: unknown): D1Database {
  return (context as { db: D1Database }).db;
}

function ctxCaller(context: unknown): Caller {
  const s = ctxSession(context);
  return { id: s.userId, role: s.role };
}

export const getMyProfileExtraD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => getMyProfileExtra(ctxDb(context), ctxCaller(context)));

export const updateMyFullNameD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { fullName: string })
  .handler(async ({ data, context }) =>
    updateMyFullName(ctxDb(context), ctxCaller(context), data.fullName),
  );

export const updateMySubjectD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { subjectsText: string })
  .handler(async ({ data, context }) =>
    updateMySubject(ctxDb(context), ctxCaller(context), data.subjectsText),
  );
